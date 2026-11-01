/**
 * R111（2026-11-01）：对账入口的单测（恢复闭环的自动化覆盖）。
 *
 * - 目标组对账：清在途组、追加说明、revision+1；
 * - 任务对账：running ⇒ pending，不改其它任务；
 * - 不匹配/空说明被拒（防止"对账"变成盲放行）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../packages/core/src/public-sdk.js";
import { GoalModeStateStore } from "../../packages/core/src/orchestration/goal-mode-store.js";
import { TaskStore } from "../../packages/core/src/infra/task-store.js";
import type { TaskChainDocument } from "../../packages/core/src/core/types.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "astarray-reconcile-"));
  directories.push(directory);
  return directory;
}

function buildChain(): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "mission-x",
    revision: 1,
    updatedAtIso: "2026-11-01T00:00:00.000Z",
    tasks: [
      {
        id: "T-01",
        description: "done task",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
        assignedAgentId: null,
        status: "done",
        resultLocation: null,
      },
      {
        id: "T-02",
        description: "running task",
        dependsOn: ["T-01"],
        taskType: "data",
        toolNames: [],
        assignedAgentId: null,
        status: "running",
        resultLocation: null,
      },
    ],
  };
}

describe("恢复闭环的对账入口", () => {
  it("任务对账：running ⇒ pending，其余任务不变，revision+1", async () => {
    const stateDirectory = await createStateDirectory();
    const taskStore = new TaskStore({ baseDirectory: stateDirectory });
    await taskStore.writeTaskChain(buildChain());
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
    });
    try {
      const result = await application.reconcileMissionTask({
        missionIdentifier: "mission-x",
        taskIdentifier: "T-02",
        note: "核对：未产生副作用",
      });
      expect(result.reconciled).toBe(true);
      expect(result.previousStatus).toBe("running");
      const chain = await taskStore.readTaskChain("mission-x");
      expect(chain?.revision).toBe(2);
      expect(chain?.tasks.find((task) => task.id === "T-02")?.status).toBe("pending");
      expect(chain?.tasks.find((task) => task.id === "T-01")?.status).toBe("done");
    } finally {
      await application.shutdown();
    }
  });

  it("任务对账：非 running/blocked 或空说明被拒", async () => {
    const stateDirectory = await createStateDirectory();
    const taskStore = new TaskStore({ baseDirectory: stateDirectory });
    await taskStore.writeTaskChain(buildChain());
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
    });
    try {
      await expect(
        application.reconcileMissionTask({
          missionIdentifier: "mission-x",
          taskIdentifier: "T-01",
          note: "已完成的无需对账",
        }),
      ).rejects.toThrow();
      await expect(
        application.reconcileMissionTask({
          missionIdentifier: "mission-x",
          taskIdentifier: "T-02",
          note: "   ",
        }),
      ).rejects.toThrow();
    } finally {
      await application.shutdown();
    }
  });

  it("目标组对账：清空在途组并追加说明", async () => {
    const stateDirectory = await createStateDirectory();
    const stateStore = new GoalModeStateStore({ baseDirectory: stateDirectory });
    await stateStore.write({
      schemaVersion: 1,
      documentRevision: 1,
      goalIdentifier: "goal-x",
      contractRevision: 1,
      ownerIdentifier: "owner-1",
      sourceRequestReference: "user-message-1",
      requirementBases: [],
      lastPotentialValue: 1,
      currentTaskGroupIdentifier: "group-1",
      currentTaskGroupStartedAtIso: "2026-11-01T00:00:00.000Z",
      consumedToolCalls: 1,
      consumedCostUnits: 0,
      pauseReason: null,
      evidenceGaps: [],
      requiresReplanning: false,
      isExperimentClosed: false,
      closedAtIso: null,
      gateSnapshot: {
        goalIdentifier: "goal-x",
        contractRevision: 1,
        completedGroupCount: 1,
        checksSinceLastReduction: 0,
        lastPotentialValue: 1,
        bestPotentialValue: null,
        isPaused: false,
        pauseReason: null,
        evidenceGaps: [],
        consumedToolCalls: 1,
        requiresReplanning: false,
      },
      updatedAtIso: "2026-11-01T00:00:00.000Z",
    });
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
    });
    try {
      const result = await application.reconcileGoalTaskGroup({
        goalIdentifier: "goal-x",
        taskGroupIdentifier: "group-1",
        note: "核对：无副作用",
      });
      expect(result.reconciled).toBe(true);
      const state = await stateStore.read("goal-x");
      expect(state?.currentTaskGroupIdentifier).toBeNull();
      expect(state?.evidenceGaps.join("；")).toContain("group-1");
    } finally {
      await application.shutdown();
    }
  });
});
