/**
 * R74（2026-10-31）：K7 目标完成判定的单测。
 *
 * 只测纯函数：状态缺失之外的规则（revision 不一致、需重规划、暂停、依据缺失/不足/剩余量、
 * 多余依据、V 非 0/未计算），以及"实验已关闭 ⇒ 不适用（不阻断）"。
 */
import { describe, expect, it } from "vitest";

import { evaluateGoalCompletion } from "../../packages/core/src/orchestration/goal-completion-requirement.js";
import type { GoalContract } from "../../packages/core/src/orchestration/goal-contract.js";
import type { PersistedGoalModeState } from "../../packages/core/src/orchestration/goal-mode-store.js";

function buildContract(): GoalContract {
  return {
    schemaVersion: 1,
    goalIdentifier: "goal-a",
    revision: 2,
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
    ],
    resourceLimits: {
      maximumToolCalls: null,
      maximumWallClockSeconds: null,
      maximumCostUnits: null,
    },
    deadlineIso: null,
    pauseConditions: [],
    supersedesRevision: 1,
  };
}

function buildState(overrides: Partial<PersistedGoalModeState> = {}): PersistedGoalModeState {
  return {
    schemaVersion: 1,
    documentRevision: 5,
    goalIdentifier: "goal-a",
    contractRevision: 2,
    ownerIdentifier: "owner-1",
    sourceRequestReference: "user-message-1",
    requirementBases: [
      {
        requirementIdentifier: "req-1",
        weight: 1,
        evidence: {
          kind: "valid",
          evidenceKind: "independent-acceptance",
          evidenceReference: "task-ledger:task-1",
        },
        remainingContribution: 0,
      },
    ],
    lastPotentialValue: 0,
    currentTaskGroupIdentifier: null,
    currentTaskGroupStartedAtIso: null,
    consumedToolCalls: 3,
    consumedCostUnits: 0,
    pauseReason: null,
    evidenceGaps: [],
    requiresReplanning: false,
    isExperimentClosed: false,
    closedAtIso: null,
    gateSnapshot: {
      goalIdentifier: "goal-a",
      contractRevision: 2,
      completedGroupCount: 3,
      checksSinceLastReduction: 0,
      lastPotentialValue: 0,
      bestPotentialValue: 0,
      isPaused: false,
      pauseReason: null,
      evidenceGaps: [],
      consumedToolCalls: 3,
      requiresReplanning: false,
    },
    updatedAtIso: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("evaluateGoalCompletion", () => {
  it("证据齐备且 V=0 ⇒ 允许完成", () => {
    const decision = evaluateGoalCompletion({
      contract: buildContract(),
      state: buildState(),
    });
    expect(decision.isApplicable).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.isAllowed).toBe(true);
  });

  it("revision 不一致 / 需重规划 / 已暂停 分别不通过", () => {
    for (const state of [
      buildState({ contractRevision: 1 }),
      buildState({ requiresReplanning: true }),
      buildState({ pauseReason: "证据不足" }),
    ]) {
      const decision = evaluateGoalCompletion({ contract: buildContract(), state });
      expect(decision.isAllowed).toBe(false);
    }
  });

  it("缺依据 / 证据非 valid / 仍有剩余量 / V 非 0 ⇒ 不通过", () => {
    for (const state of [
      buildState({ requirementBases: [] }),
      buildState({
        requirementBases: [
          {
            requirementIdentifier: "req-1",
            weight: 1,
            evidence: { kind: "unverified", reason: "缺裁决" },
            remainingContribution: 1,
          },
        ],
      }),
      buildState({ lastPotentialValue: 0.5 }),
      buildState({ lastPotentialValue: null }),
    ]) {
      const decision = evaluateGoalCompletion({ contract: buildContract(), state });
      expect(decision.isAllowed).toBe(false);
      expect(decision.reasons.length).toBeGreaterThan(0);
    }
  });

  it("存在不属于契约的依据 ⇒ 不通过（不静默忽略）", () => {
    const state = buildState({
      requirementBases: [
        ...buildState().requirementBases,
        {
          requirementIdentifier: "req-stale",
          weight: 1,
          evidence: {
            kind: "valid",
            evidenceKind: "deterministic-check",
            evidenceReference: "task-ledger:task-x",
          },
          remainingContribution: 0,
        },
      ],
    });
    const decision = evaluateGoalCompletion({ contract: buildContract(), state });
    expect(decision.isAllowed).toBe(false);
    expect(decision.reasons.join("；")).toContain("req-stale");
  });

  it("实验已关闭 ⇒ 不适用且不阻断收口", () => {
    const decision = evaluateGoalCompletion({
      contract: buildContract(),
      state: buildState({ isExperimentClosed: true, lastPotentialValue: 1 }),
    });
    expect(decision.isApplicable).toBe(false);
    expect(decision.isAllowed).toBe(true);
  });
});
