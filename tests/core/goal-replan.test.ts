/**
 * R138（2026-11-03）：暂停后恢复（重新规划确认）的单测。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../packages/core/src/public-sdk.js";
import { GoalModeStateStore } from "../../packages/core/src/orchestration/goal-mode-store.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createSeededApplication(): Promise<{
  application: AstarrayApplicationFacade;
  stateStore: GoalModeStateStore;
  goalIdentifier: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "astarray-replan-"));
  directories.push(directory);
  const stateStore = new GoalModeStateStore({ baseDirectory: directory });
  const goalIdentifier = "goal-replan";
  await stateStore.write({
    schemaVersion: 1,
    documentRevision: 2,
    goalIdentifier,
    contractRevision: 1,
    ownerIdentifier: "user-local",
    sourceRequestReference: "user-message:replan",
    requirementBases: [],
    lastPotentialValue: 1,
    currentTaskGroupIdentifier: null,
    currentTaskGroupStartedAtIso: null,
    consumedToolCalls: 1,
    consumedCostUnits: 0,
    pauseReason: "图变更导致 V 上升：0 → 1，需重新规划",
    evidenceGaps: ["图变更导致 V 上升：0 → 1，需重新规划"],
    requiresReplanning: true,
    isExperimentClosed: false,
    closedAtIso: null,
    gateSnapshot: {
      goalIdentifier,
      contractRevision: 1,
      completedGroupCount: 1,
      checksSinceLastReduction: 0,
      lastPotentialValue: 1,
      bestPotentialValue: null,
      isPaused: true,
      pauseReason: "图变更导致 V 上升：0 → 1，需重新规划",
      evidenceGaps: ["图变更导致 V 上升：0 → 1，需重新规划"],
      consumedToolCalls: 1,
      requiresReplanning: true,
    },
    updatedAtIso: "2026-11-03T00:00:00.000Z",
  });
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: directory,
    mode: "assist",
    runtime: "mock",
  });
  return { application, stateStore, goalIdentifier };
}

describe("暂停后恢复（replanGoal）", () => {
  it("清除 requiresReplanning/暂停并记录说明；重复调用拒绝", async () => {
    const { application, stateStore, goalIdentifier } =
      await createSeededApplication();
    try {
      const first = await application.replanGoal({
        goalIdentifier,
        note: "已补映射并重排任务",
      });
      expect(first.resumed).toBe(true);
      const state = await stateStore.read(goalIdentifier);
      expect(state?.requiresReplanning).toBe(false);
      expect(state?.pauseReason).toBeNull();
      expect(state?.gateSnapshot.requiresReplanning).toBe(false);
      expect(state?.evidenceGaps.join("；")).toContain("已补映射并重排任务");

      const second = await application.replanGoal({
        goalIdentifier,
        note: "再次",
      });
      expect(second.resumed).toBe(false);
    } finally {
      await application.shutdown();
    }
  });

  it("空说明被拒；不存在的目标被拒", async () => {
    const { application, goalIdentifier } = await createSeededApplication();
    try {
      await expect(
        application.replanGoal({ goalIdentifier, note: "   " }),
      ).rejects.toThrow();
      await expect(
        application.replanGoal({ goalIdentifier: "goal-none", note: "说明" }),
      ).rejects.toThrow();
    } finally {
      await application.shutdown();
    }
  });
});
