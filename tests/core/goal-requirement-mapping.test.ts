/**
 * R72（2026-10-31）：K2 要求 ↔ 任务节点映射的单测。
 *
 * 覆盖：存储的绑定/覆盖/清除、契约 revision 不一致 ⇒ 映射失效，
 * 以及评估函数优先使用动态映射（而不是契约静态字段）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assessGoalRequirementsFromLocalState } from "../../packages/core/src/orchestration/goal-requirement-assessment.js";
import { GoalRequirementMappingStore } from "../../packages/core/src/orchestration/goal-requirement-mapping-store.js";
import type { GoalContract } from "../../packages/core/src/orchestration/goal-contract.js";

const directories: string[] = [];

async function createStore(): Promise<{
  store: GoalRequirementMappingStore;
  directory: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "astarray-goal-mapping-"));
  directories.push(directory);
  return { store: new GoalRequirementMappingStore({ baseDirectory: directory }), directory };
}

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

function buildContract(overrides: Partial<GoalContract> = {}): GoalContract {
  return {
    schemaVersion: 1,
    goalIdentifier: "goal-a",
    revision: 1,
    ownerIdentifier: "owner-1",
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
        taskNodeIdentifiers: [],
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
  };
}

describe("GoalRequirementMappingStore", () => {
  it("绑定后可读回，并按 requirement 覆盖（不重复）", async () => {
    const { store } = await createStore();
    await store.setMapping({
      goalIdentifier: "goal-a",
      contractRevision: 1,
      requirementIdentifier: "req-1",
      taskNodeIdentifiers: ["task-1"],
    });
    const updated = await store.setMapping({
      goalIdentifier: "goal-a",
      contractRevision: 1,
      requirementIdentifier: "req-1",
      taskNodeIdentifiers: ["task-2", "task-2", " task-3 "],
    });
    expect(updated.mappings).toHaveLength(1);
    expect(updated.mappings[0]?.taskNodeIdentifiers).toEqual(["task-2", "task-3"]);
    expect(updated.documentRevision).toBe(2);
  });

  it("空任务列表 ⇒ 清除该要求映射", async () => {
    const { store } = await createStore();
    await store.setMapping({
      goalIdentifier: "goal-a",
      contractRevision: 1,
      requirementIdentifier: "req-1",
      taskNodeIdentifiers: ["task-1"],
    });
    const cleared = await store.setMapping({
      goalIdentifier: "goal-a",
      contractRevision: 1,
      requirementIdentifier: "req-1",
      taskNodeIdentifiers: [],
    });
    expect(cleared.mappings).toEqual([]);
  });

  it("契约 revision 不一致 ⇒ readForContractRevision 返回 null（映射失效）", async () => {
    const { store } = await createStore();
    await store.setMapping({
      goalIdentifier: "goal-a",
      contractRevision: 1,
      requirementIdentifier: "req-1",
      taskNodeIdentifiers: ["task-1"],
    });
    expect(await store.readForContractRevision("goal-a", 1)).not.toBeNull();
    expect(await store.readForContractRevision("goal-a", 2)).toBeNull();
  });
});

describe("assessGoalRequirementsFromLocalState 使用动态映射", () => {
  it("动态映射优先于契约静态字段", () => {
    const contract = buildContract({
      requirements: [
        {
          requirementIdentifier: "req-1",
          description: "写完说明",
          weight: 1,
          completionPredicateKind: "deterministic-check",
          taskNodeIdentifiers: ["task-static"],
        },
      ],
    });
    const assessments = assessGoalRequirementsFromLocalState({
      contract,
      missionTaskStatusByTaskIdentifier: new Map([
        ["task-static", "pending"],
        ["task-mapped", "done"],
      ]),
      taskIdentifiersWithAcceptedVerdict: new Set(["task-mapped"]),
      taskNodeIdentifiersByRequirement: new Map([["req-1", ["task-mapped"]]]),
    });
    expect(assessments[0]?.evidence.kind).toBe("valid");
  });

  it("没有动态映射 ⇒ 回退契约静态字段（静态节点未完成 ⇒ unverified）", () => {
    const contract = buildContract({
      requirements: [
        {
          requirementIdentifier: "req-1",
          description: "写完说明",
          weight: 1,
          completionPredicateKind: "deterministic-check",
          taskNodeIdentifiers: ["task-static"],
        },
      ],
    });
    const assessments = assessGoalRequirementsFromLocalState({
      contract,
      missionTaskStatusByTaskIdentifier: new Map([["task-static", "pending"]]),
      taskIdentifiersWithAcceptedVerdict: new Set(),
    });
    expect(assessments[0]?.evidence.kind).toBe("unverified");
  });
});
