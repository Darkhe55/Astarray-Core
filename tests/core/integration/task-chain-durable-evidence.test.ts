/**
 * WIRING-04 回归（2026-11-18 巡检轮）：**证据与来源字段必须经得起落盘往返**。
 *
 * §29 发现过一类静默数据丢失：zod 默认丢弃未知字段，schema 未登记就"写了也读不回来"。
 * 本用例用**真实 TaskStore**（写文件 + 读回）证明：
 * - `coordinationApplicationEvidence` 落盘后仍可读；
 * - 节点的 `sourceSequence*` 三个来源字段落盘后仍可读；
 * - 新实例重新读取（模拟进程重启）仍然可见。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStore } from "../../../packages/core/src/infra/task-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-durable-chain-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): TaskStore {
  return new TaskStore({ baseDirectory: stateDirectory });
}

describe("任务链落盘往返", () => {
  it("① 应用证据与来源字段落盘后可读回（新实例也一样）", async () => {
    const store = buildStore();
    await store.writeTaskChain({
      schemaVersion: 1,
      missionId: "mission-1",
      revision: 1,
      updatedAtIso: "2026-11-18T00:00:00.000Z",
      tasks: [
        {
          id: "T-001",
          description: "执行",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
          assignedAgentId: "worker-1",
          status: "done",
          resultLocation: null,
          sourceSequenceTaskIdentifier: "task-mission-1",
          sourceSequenceIdentifier: "sequence-agent-1",
          sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
        },
      ],
      coordinationApplicationEvidence: [
        {
          messageIdentifier: "message-1",
          appliedAtIso: "2026-11-18T00:00:00.000Z",
          resultingTaskStatus: "done",
        },
      ],
    } as never);

    /** 新实例 = 模拟进程重启：只能靠磁盘。 */
    const reloaded = await buildStore().readTaskChain("mission-1");
    expect(reloaded).not.toBeNull();
    expect(reloaded?.coordinationApplicationEvidence).toHaveLength(1);
    expect(reloaded?.coordinationApplicationEvidence?.[0]).toMatchObject({
      messageIdentifier: "message-1",
      resultingTaskStatus: "done",
    });
    expect(reloaded?.tasks[0]).toMatchObject({
      sourceSequenceTaskIdentifier: "task-mission-1",
      sourceSequenceIdentifier: "sequence-agent-1",
      sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
    });
  }, 60_000);

  it("② updateTaskChain 追加证据后，旧证据仍保留（不覆盖、不丢）", async () => {
    const store = buildStore();
    await store.writeTaskChain({
      schemaVersion: 1,
      missionId: "mission-2",
      revision: 1,
      updatedAtIso: "2026-11-18T00:00:00.000Z",
      tasks: [
        {
          id: "T-001",
          description: "执行",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
          assignedAgentId: null,
          status: "running",
          resultLocation: null,
        },
      ],
      coordinationApplicationEvidence: [
        {
          messageIdentifier: "message-old",
          appliedAtIso: "2026-11-18T00:00:00.000Z",
          resultingTaskStatus: "done",
        },
      ],
    } as never);

    await store.updateTaskChain("mission-2", (current) => {
      if (current === null) {
        throw new Error("任务链必须存在");
      }
      return {
        ...current,
        revision: current.revision + 1,
        updatedAtIso: "2026-11-18T00:00:01.000Z",
        coordinationApplicationEvidence: [
          ...(current.coordinationApplicationEvidence ?? []),
          {
            messageIdentifier: "message-new",
            appliedAtIso: "2026-11-18T00:00:01.000Z",
            resultingTaskStatus: "failed",
          },
        ],
      };
    });

    const reloaded = await buildStore().readTaskChain("mission-2");
    expect(
      reloaded?.coordinationApplicationEvidence?.map((evidence) => evidence.messageIdentifier),
    ).toEqual(["message-old", "message-new"]);
    expect(reloaded?.revision).toBe(2);
  }, 60_000);
});
