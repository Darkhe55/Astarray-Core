/**
 * B9（2026-11-24）：目标模式持久化状态的恢复判定与状态视图分支。
 *
 * 纪律：恢复前必须对账；在途组先对账、实验关闭/暂停均不恢复；契约版本/原始要求不一致直接拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GOAL_MODE_STATE_SCHEMA_VERSION,
  GoalModeStateStore,
  type PersistedGoalModeState,
} from "../../../packages/core/src/orchestration/goal-mode-store.js";
import type { GoalContract } from "../../../packages/core/src/orchestration/goal-contract.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-goal-store-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const nowIso = "2026-11-24T00:00:00.000Z";

function state(overrides: Partial<PersistedGoalModeState> = {}): PersistedGoalModeState {
  return {
    schemaVersion: GOAL_MODE_STATE_SCHEMA_VERSION,
    documentRevision: 1,
    goalIdentifier: "goal-1",
    contractRevision: 1,
    ownerIdentifier: "user-1",
    sourceRequestReference: "request-1",
    requirementBases: [],
    lastPotentialValue: 0.5,
    currentTaskGroupIdentifier: null,
    currentTaskGroupStartedAtIso: null,
    consumedToolCalls: 0,
    consumedCostUnits: 0,
    pauseReason: null,
    evidenceGaps: [],
    requiresReplanning: false,
    isExperimentClosed: false,
    closedAtIso: null,
    gateSnapshot: {
      goalIdentifier: "goal-1",
      contractRevision: 1,
      completedGroupCount: 0,
      checksSinceLastReduction: 0,
      lastPotentialValue: 0.5,
      bestPotentialValue: 0.5,
      isPaused: false,
      pauseReason: null,
      evidenceGaps: [],
      consumedToolCalls: 0,
      requiresReplanning: false,
    },
    updatedAtIso: nowIso,
    ...overrides,
  };
}

function contract(overrides: Partial<GoalContract> = {}): GoalContract {
  return {
    schemaVersion: 1,
    goalIdentifier: "goal-1",
    revision: 1,
    ownerIdentifier: "user-1",
    sourceRequestReference: "request-1",
    objectiveText: "目标",
    scope: { projectIdentifiers: ["project-a"], allowedToolNames: null },
    nonViolableInvariants: [],
    requirements: [],
    resourceLimits: { maximumToolCalls: null, maximumWallClockSeconds: null, maximumCostUnits: null },
    deadlineIso: null,
    pauseConditions: [],
    supersedesRevision: null,
    ...overrides,
  } as GoalContract;
}

async function storeWith(value: PersistedGoalModeState | null): Promise<GoalModeStateStore> {
  const store = new GoalModeStateStore({ baseDirectory });
  if (value !== null) {
    await store.write(value);
  }
  return store;
}

describe("B9：目标状态恢复判定", () => {
  it("① 无持久化状态 ⇒ resume（按首次运行处理，不猜 V）", async () => {
    const store = await storeWith(null);
    expect(await store.evaluateResume({ goalIdentifier: "goal-1", contract: contract() })).toMatchObject({
      kind: "resume",
      lastPotentialValue: null,
    });
  });

  it("② 版本或原始要求不一致 ⇒ 抛错（不把旧状态套新目标）", async () => {
    /** 注：状态文件按 goalIdentifier 命名，"读到别的 goal"在正常路径不可出现（防御分支）。 */
    const mismatchedRevision = await storeWith(state({ contractRevision: 2 }));
    await expect(
      mismatchedRevision.evaluateResume({ goalIdentifier: "goal-1", contract: contract() }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });

    const mismatchedReference = await storeWith(state({ sourceRequestReference: "other-request" }));
    await expect(
      mismatchedReference.evaluateResume({ goalIdentifier: "goal-1", contract: contract() }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
  });

  it("③ 实验已关闭 ⇒ stay-paused（不恢复新增派发）", async () => {
    const store = await storeWith(state({ isExperimentClosed: true, closedAtIso: nowIso }));
    expect(await store.evaluateResume({ goalIdentifier: "goal-1", contract: contract() })).toMatchObject({
      kind: "stay-paused",
      pauseReason: "实验已关闭",
    });
  });

  it("④ 存在未收口任务组 ⇒ reconcile-first（禁止直接重跑）", async () => {
    const store = await storeWith(state({ currentTaskGroupIdentifier: "group-9" }));
    expect(await store.evaluateResume({ goalIdentifier: "goal-1", contract: contract() })).toEqual({
      kind: "reconcile-first",
      detail: "存在未收口的任务组：先对账副作用，禁止直接重跑（避免重复副作用）。",
      inFlightTaskGroupIdentifier: "group-9",
    });
  });

  it("⑤ 需重新规划或有暂停原因 ⇒ stay-paused 并带证据缺口", async () => {
    const replanning = await storeWith(state({ requiresReplanning: true }));
    expect(await replanning.evaluateResume({ goalIdentifier: "goal-1", contract: contract() })).toMatchObject({
      kind: "stay-paused",
      pauseReason: "requires-replanning",
    });
    const paused = await storeWith(
      state({ pauseReason: "等待授权", evidenceGaps: ["缺少验收证据"] }),
    );
    expect(await paused.evaluateResume({ goalIdentifier: "goal-1", contract: contract() })).toEqual({
      kind: "stay-paused",
      detail: "等待授权",
      pauseReason: "等待授权",
      evidenceGaps: ["缺少验收证据"],
    });
  });

  it("⑥ 无在途/无暂停 ⇒ resume 并带上次 V", async () => {
    const store = await storeWith(state({ lastPotentialValue: 0.75 }));
    expect(await store.evaluateResume({ goalIdentifier: "goal-1", contract: contract() })).toEqual({
      kind: "resume",
      detail: "对账通过：没有在途组、没有暂停，按持久化预算继续。",
      lastPotentialValue: 0.75,
    });
  });
});

describe("B9：关闭实验与状态视图", () => {
  it("⑦ closeExperiment：无状态 ⇒ mission-not-found；有状态 ⇒ 只置标记并递增 revision", async () => {
    const empty = await storeWith(null);
    await expect(
      empty.closeExperiment({ goalIdentifier: "goal-1", closedAtIso: nowIso, reason: "用户关闭" }),
    ).rejects.toMatchObject({ errorCode: "mission-not-found" });

    const store = await storeWith(state());
    await store.closeExperiment({ goalIdentifier: "goal-1", closedAtIso: nowIso, reason: "用户关闭" });
    const after = await store.read("goal-1");
    expect(after?.isExperimentClosed).toBe(true);
    expect(after?.closedAtIso).toBe(nowIso);
    expect(after?.documentRevision).toBe(2);
  });

  it("⑧ describeStatus：无状态 ⇒ null；检查点按在途/关闭/重规划/默认四态", async () => {
    const empty = await storeWith(null);
    expect(await empty.describeStatus("goal-1")).toBeNull();

    const inflight = await storeWith(state({ currentTaskGroupIdentifier: "group-9" }));
    expect((await inflight.describeStatus("goal-1"))?.nextCheckpoint).toBe(
      "先对账在途组 group-9",
    );

    const closed = await storeWith(state({ isExperimentClosed: true }));
    expect((await closed.describeStatus("goal-1"))?.nextCheckpoint).toBe(
      "实验已关闭：无自动检查点",
    );

    const replan = await storeWith(state({ requiresReplanning: true }));
    expect((await replan.describeStatus("goal-1"))?.nextCheckpoint).toBe(
      "重新规划后设置新检查点",
    );

    const normal = await storeWith(state());
    expect((await normal.describeStatus("goal-1"))?.nextCheckpoint).toBe(
      "下三个已结束任务组后检查一次进展",
    );
  });
});
