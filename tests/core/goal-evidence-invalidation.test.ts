/**
 * R79（2026-10-31）：K5 证据失效状态变换的单测。
 *
 * 覆盖：只标记指定要求、剩余量回到权重、V 上升、requiresReplanning/暂停原因/证据缺口、
 * 未知要求被拒、unreliable 谓词 ⇒ V 为 null（不给伪数字）。
 */
import { describe, expect, it } from "vitest";

import { buildInvalidatedGoalState } from "../../packages/core/src/orchestration/goal-evidence-invalidation.js";
import type { GoalContract } from "../../packages/core/src/orchestration/goal-contract.js";
import type { PersistedGoalModeState } from "../../packages/core/src/orchestration/goal-mode-store.js";

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
        taskNodeIdentifiers: ["task-1"],
      },
      {
        requirementIdentifier: "req-2",
        description: "写完示例",
        weight: 2,
        completionPredicateKind: "deterministic-check",
        taskNodeIdentifiers: ["task-2"],
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

function buildState(): PersistedGoalModeState {
  return {
    schemaVersion: 1,
    documentRevision: 3,
    goalIdentifier: "goal-a",
    contractRevision: 1,
    ownerIdentifier: "owner-1",
    sourceRequestReference: "user-message-1",
    requirementBases: [
      {
        requirementIdentifier: "req-1",
        weight: 1,
        evidence: {
          kind: "valid",
          evidenceKind: "deterministic-check",
          evidenceReference: "task-ledger:task-1",
        },
        remainingContribution: 0,
      },
      {
        requirementIdentifier: "req-2",
        weight: 2,
        evidence: {
          kind: "valid",
          evidenceKind: "independent-acceptance",
          evidenceReference: "task-ledger:task-2",
        },
        remainingContribution: 0,
      },
    ],
    lastPotentialValue: 0,
    currentTaskGroupIdentifier: null,
    currentTaskGroupStartedAtIso: null,
    consumedToolCalls: 7,
    consumedCostUnits: 0,
    pauseReason: null,
    evidenceGaps: [],
    requiresReplanning: false,
    isExperimentClosed: false,
    closedAtIso: null,
    gateSnapshot: {
      goalIdentifier: "goal-a",
      contractRevision: 1,
      completedGroupCount: 2,
      checksSinceLastReduction: 0,
      lastPotentialValue: 0,
      bestPotentialValue: 0,
      isPaused: false,
      pauseReason: null,
      evidenceGaps: [],
      consumedToolCalls: 7,
      requiresReplanning: false,
    },
    updatedAtIso: "2026-10-31T00:00:00.000Z",
  };
}

describe("buildInvalidatedGoalState", () => {
  it("只标记指定要求，剩余量回到权重，V 上升且置暂停/重规划", () => {
    const result = buildInvalidatedGoalState({
      contract: buildContract(),
      state: buildState(),
      requirementIdentifiers: ["req-2"],
      reason: "上游文件被删除",
      nowIso: "2026-10-31T01:00:00.000Z",
    });
    const reqTwo = result.nextState.requirementBases.find(
      (basis) => basis.requirementIdentifier === "req-2",
    );
    const reqOne = result.nextState.requirementBases.find(
      (basis) => basis.requirementIdentifier === "req-1",
    );
    expect(reqTwo?.evidence.kind).toBe("invalidated");
    expect(reqTwo?.remainingContribution).toBe(2);
    expect(reqOne?.evidence.kind).toBe("valid");
    expect(result.potentialValueAfterInvalidation).toBe(2);
    expect(result.nextState.requiresReplanning).toBe(true);
    expect(result.nextState.pauseReason).toContain("上游文件被删除");
    expect(result.nextState.evidenceGaps.join("；")).toContain("req-2");
    expect(result.nextState.gateSnapshot.isPaused).toBe(true);
    expect(result.nextState.documentRevision).toBe(4);
  });

  it("未知要求 ⇒ 抛错（不静默忽略）", () => {
    expect(() =>
      buildInvalidatedGoalState({
        contract: buildContract(),
        state: buildState(),
        requirementIdentifiers: ["req-missing"],
        reason: "x",
        nowIso: "2026-10-31T01:00:00.000Z",
      }),
    ).toThrow();
  });

  it("存在 unreliable 谓词 ⇒ V 为 null（不给伪数字），但仍置暂停/重规划", () => {
    const result = buildInvalidatedGoalState({
      contract: buildContract({
        requirements: [
          {
            requirementIdentifier: "req-1",
            description: "写完说明",
            weight: 1,
            completionPredicateKind: "unreliable",
            taskNodeIdentifiers: ["task-1"],
          },
        ],
      }),
      state: buildState(),
      requirementIdentifiers: ["req-1"],
      reason: "证据来源不可靠",
      nowIso: "2026-10-31T01:00:00.000Z",
    });
    expect(result.potentialValueAfterInvalidation).toBeNull();
    expect(result.nextState.lastPotentialValue).toBeNull();
    expect(result.nextState.requiresReplanning).toBe(true);
  });
});
