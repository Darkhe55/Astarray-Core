/**
 * R96（2026-11-01）：组性质持久化的单测。
 *
 * 组结束时写入 `lastTaskGroupKind`，并**不得**覆盖已有的暂停原因/消耗计数
 * （组结束会与治理停止并发，这一点由合并逻辑保证）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GoalModeStateStore } from "../../packages/core/src/orchestration/goal-mode-store.js";
import type { PersistedGoalModeState } from "../../packages/core/src/orchestration/goal-mode-store.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function buildState(): PersistedGoalModeState {
  return {
    schemaVersion: 1,
    documentRevision: 1,
    goalIdentifier: "goal-a",
    contractRevision: 1,
    ownerIdentifier: "owner-1",
    sourceRequestReference: "user-message-1",
    requirementBases: [],
    lastPotentialValue: 1,
    goalStartedAtIso: "2026-10-31T00:00:00.000Z",
    currentTaskGroupIdentifier: "group-1",
    currentTaskGroupStartedAtIso: "2026-10-31T00:00:00.000Z",
    consumedToolCalls: 1,
    pauseReason: "工具调用预算已用尽",
    consumedCostUnits: 0,
    evidenceGaps: ["预算缺口"],
    requiresReplanning: false,
    isExperimentClosed: false,
    closedAtIso: null,
    gateSnapshot: {
      goalIdentifier: "goal-a",
      contractRevision: 1,
      completedGroupCount: 1,
      checksSinceLastReduction: 0,
      lastPotentialValue: 1,
      bestPotentialValue: null,
      isPaused: true,
      pauseReason: "工具调用预算已用尽",
      evidenceGaps: ["预算缺口"],
      consumedToolCalls: 1,
      requiresReplanning: false,
    },
    updatedAtIso: "2026-10-31T00:00:00.000Z",
  };
}

describe("GoalModeStateStore 组性质持久化", () => {
  it("finishTaskGroup 写入 lastTaskGroupKind 且保留暂停原因", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-goal-state-"));
    directories.push(directory);
    const store = new GoalModeStateStore({ baseDirectory: directory });
    const state = buildState();
    await store.write(state);
    const finished = await store.finishTaskGroup({
      state,
      finishedAtIso: "2026-10-31T00:05:00.000Z",
      gateSnapshot: state.gateSnapshot,
      requirementBases: state.requirementBases,
      lastPotentialValue: state.lastPotentialValue,
      consumedToolCalls: state.consumedToolCalls,
      groupKind: "rework",
    });
    expect(finished.lastTaskGroupKind).toBe("rework");
    expect(finished.pauseReason).toBe("工具调用预算已用尽");
    const status = await store.describeStatus("goal-a");
    expect(status?.lastTaskGroupKind).toBe("rework");
  });
});
