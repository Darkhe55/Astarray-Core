/**
 * WIRING-04 §36.2 反例：会话运行登记与目标契约（2026-11-19）。
 *
 * - 会话运行登记是累积型：并发开跑若互相覆盖，会丢运行记录（身份/归属断链）。
 * - 目标契约 revision 决定验收判定：旧版本覆盖必须显式冲突。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationIdentityStore } from "../../../packages/core/src/orchestration/conversation-identity-store.js";
import {
  GOAL_CONTRACT_SCHEMA_VERSION,
  type GoalContract,
} from "../../../packages/core/src/orchestration/goal-contract.js";
import { GoalContractStore } from "../../../packages/core/src/orchestration/goal-contract-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "identity-contract-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildContract(overrides: Record<string, unknown> = {}): GoalContract {
  return {
    schemaVersion: GOAL_CONTRACT_SCHEMA_VERSION,
    goalIdentifier: "goal-1",
    revision: 1,
    ownerIdentifier: "user-1",
    sourceRequestReference: "user-message-1",
    objectiveText: "把文档补完",
    scope: { projectIdentifiers: [], allowedToolNames: null },
    nonViolableInvariants: [],
    requirements: [
      {
        requirementIdentifier: "req-1",
        description: "写完说明",
        weight: 1,
        completionPredicateKind: "deterministic-check",
      },
    ],
    resourceLimits: {
      maximumToolCalls: null,
      maximumWallClockSeconds: null,
      maximumCostUnits: null,
    },
    deadlineIso: null,
    pauseConditions: [],
    supersedesRevision: null,
    ...overrides,
  } as never;
}

describe("目标契约：陈旧版本写入", () => {
  it("① A 用旧 revision 提交 ⇒ 冲突，磁盘保留 B 的契约", async () => {
    const storeA = new GoalContractStore({ baseDirectory: stateDirectory });
    const storeB = new GoalContractStore({ baseDirectory: stateDirectory });
    await storeA.save(buildContract());

    /** A 读到 revision 1（之后要用的"旧值"）。 */
    expect((await storeA.read("goal-1"))?.revision).toBe(1);

    /** B 提交 revision 2（最终裁决）。 */
    const bWrite = await storeB.saveIfRevision({
      contract: buildContract({ revision: 2, objectiveText: "B 的契约" }),
      expectedRevision: 1,
    });
    expect(bWrite.outcome).toBe("written");

    /** A 用旧的 1 提交：必须冲突。 */
    const staleWrite = await storeA.saveIfRevision({
      contract: buildContract({ revision: 2, objectiveText: "A 的旧契约" }),
      expectedRevision: 1,
    });
    expect(staleWrite.outcome).toBe("conflict");
    expect(staleWrite.currentRevision).toBe(2);

    const reloaded = await new GoalContractStore({ baseDirectory: stateDirectory }).read("goal-1");
    expect(reloaded?.objectiveText).toBe("B 的契约");
  }, 60_000);
});

describe("会话运行登记并发", () => {
  it("② 同一会话并发开跑 2 次 ⇒ 两条运行记录都在（不互相覆盖）", async () => {
    const firstStore = new ConversationIdentityStore({ baseDirectory: stateDirectory });
    const secondStore = new ConversationIdentityStore({ baseDirectory: stateDirectory });
    const conversationIdentifier = "conversation-1";
    await firstStore.openConversation({
      projectIdentifier: "project-alpha",
      conversationIdentifier,
      mainAgentInstanceIdentifier: "main-agent-1",
    });

    const [firstRun, secondRun] = await Promise.all([
      firstStore.beginRun({
        conversationIdentifier,
        missionIdentifier: "mission-a",
        userMessageReference: "message-a",
      }),
      secondStore.beginRun({
        conversationIdentifier,
        missionIdentifier: "mission-b",
        userMessageReference: "message-b",
      }),
    ]);
    expect(firstRun.missionIdentifier).toBe("mission-a");
    expect(secondRun.missionIdentifier).toBe("mission-b");

    const document = JSON.parse(
      await fs.readFile(
        path.join(stateDirectory, "conversation-identity", "conversations.json"),
        "utf8",
      ),
    ) as { conversations: Record<string, { runs: Array<{ missionIdentifier: string | null }> }> };
    const runs = document.conversations[conversationIdentifier]?.runs ?? [];
    expect(runs.map((run) => run.missionIdentifier).sort()).toEqual(["mission-a", "mission-b"]);
  }, 60_000);
});
