/**
 * WIRING-04-01（第三步，用户裁决 2026-11-18）：**两步写之间强杀的恢复证明**。
 *
 * 场景：意图已写（ledger pending）→ 结构更新已提交（任务链 done + 证据）→ 进程终止
 *（完成回执未写）。恢复时必须：
 * - 既不重复产生状态迁移（revision 只涨一次）；
 * - 也不漏更新（链上确实是 done）；
 * - 且以**权威证据**判定，不靠猜。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";
import { CoordinationTaskApplicationLedger } from "../../../packages/core/src/orchestration/coordination-task-application-ledger.js";
import { reconcileCoordinationTaskApplications } from "../../../packages/core/src/orchestration/coordination-consumption-runner.js";
import { applyCoordinationMessageToTaskState } from "../../../packages/core/src/orchestration/coordination-task-state.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-intent-merge-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildChain(): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "mission-1",
    revision: 3,
    updatedAtIso: "2026-11-18T00:00:00.000Z",
    tasks: [
      {
        id: "T-001",
        description: "执行",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
        status: "running",
        assignedAgentId: "worker-1",
        resultLocation: null,
      } as never,
    ],
  };
}

function buildStore(chain: TaskChainDocument) {
  let current: TaskChainDocument | null = chain;
  return {
    readTaskChain: vi.fn(async () => current),
    updateTaskChain: vi.fn(
      async (_missionId: string, updater: (chain: TaskChainDocument | null) => TaskChainDocument) => {
        const next = updater(current);
        current = next;
        return next;
      },
    ),
    getCurrent: () => current,
  };
}

const PROOF = {
  code: "authoritative-completion-accepted" as const,
  decidedAtIso: "2026-11-18T00:00:00.000Z",
};

describe("WIRING-04-01：意图与结构更新之间的强杀", () => {
  it("① 崩溃在「回执未写」⇒ 恢复只补 completed，revision 不再增长", async () => {
    const ledger = new CoordinationTaskApplicationLedger({
      baseDirectory: stateDirectory,
      nowIso: () => "2026-11-18T00:00:00.000Z",
    });
    const store = buildStore(buildChain());

    /** 第一步：意图先写（崩溃窗口从这里开始）。 */
    await ledger.recordIntent({
      messageIdentifier: "message-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
    });

    /** 第二步：结构更新提交（状态 + 证据同一次写）。 */
    await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: { messageIdentifier: "message-1", taskIdentifier: "T-001", payload: { kind: "success" } },
      completionAuthorization: PROOF,
    });

    /** 此处"进程终止"：台账仍是 pending，回执未写。 */
    expect((await ledger.readAll()).get("message-1")?.status).toBe("pending");
    expect(store.getCurrent()?.revision).toBe(4);

    /** 第三步：恢复对账 —— 以**链上证据**为准，不重放。 */
    let applyCount = 0;
    const result = await reconcileCoordinationTaskApplications({
      ledger,
      isAppliedInAuthoritativeState: async ({ messageIdentifier }) =>
        store
          .getCurrent()
          ?.coordinationApplicationEvidence?.some(
            (evidence) => evidence.messageIdentifier === messageIdentifier,
          ) === true,
      applyMessage: async () => {
        applyCount += 1;
        await applyCoordinationMessageToTaskState({
          taskStore: store as never,
          missionIdentifiers: ["mission-1"],
          message: { messageIdentifier: "message-1", taskIdentifier: "T-001", payload: { kind: "success" } },
          completionAuthorization: PROOF,
        });
      },
    });

    expect(result.reconciledFromEvidenceCount).toBe(1);
    expect(applyCount).toBe(0);
    expect((await ledger.readAll()).get("message-1")?.status).toBe("completed");
    /** 关键：没有第二次状态迁移。 */
    expect(store.getCurrent()?.revision).toBe(4);
  }, 60_000);

  it("② 崩溃在「结构更新前」⇒ 恢复补做一次，且只一次", async () => {
    const ledger = new CoordinationTaskApplicationLedger({
      baseDirectory: stateDirectory,
      nowIso: () => "2026-11-18T00:00:00.000Z",
    });
    const store = buildStore(buildChain());
    await ledger.recordIntent({
      messageIdentifier: "message-2",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
    });
    /** 此处终止：没有任何结构更新。 */
    expect(store.getCurrent()?.revision).toBe(3);

    const result = await reconcileCoordinationTaskApplications({
      ledger,
      isAppliedInAuthoritativeState: async ({ messageIdentifier }) =>
        store
          .getCurrent()
          ?.coordinationApplicationEvidence?.some(
            (evidence) => evidence.messageIdentifier === messageIdentifier,
          ) === true,
      applyMessage: async ({ messageIdentifier }) => {
        await applyCoordinationMessageToTaskState({
          taskStore: store as never,
          missionIdentifiers: ["mission-1"],
          message: { messageIdentifier, taskIdentifier: "T-001", payload: { kind: "success" } },
          completionAuthorization: PROOF,
        });
      },
    });

    expect(result.replayedCount).toBe(1);
    expect(store.getCurrent()?.revision).toBe(4);
    expect(
      store.getCurrent()?.coordinationApplicationEvidence?.filter(
        (evidence) => evidence.messageIdentifier === "message-2",
      ),
    ).toHaveLength(1);
  }, 60_000);
});
