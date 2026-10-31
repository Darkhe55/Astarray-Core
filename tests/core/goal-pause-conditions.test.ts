/**
 * R76（2026-10-31）：K6 暂停条件评估的单测。
 *
 * 只测纯函数：未声明不评估、预算（工具/成本）、截止、停滞、需重规划，
 * 以及未知条件由契约校验拒绝。
 */
import { describe, expect, it } from "vitest";

import { evaluateGoalPauseConditions } from "../../packages/core/src/orchestration/goal-pause-conditions.js";
import { validateGoalContract } from "../../packages/core/src/orchestration/goal-contract.js";
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
        taskNodeIdentifiers: [],
      },
    ],
    resourceLimits: {
      maximumToolCalls: 10,
      maximumWallClockSeconds: null,
      maximumCostUnits: 5,
    },
    deadlineIso: null,
    pauseConditions: [],
    supersedesRevision: null,
    ...overrides,
  };
}

function buildState(overrides: Partial<PersistedGoalModeState> = {}): PersistedGoalModeState {
  return {
    schemaVersion: 1,
    documentRevision: 1,
    goalIdentifier: "goal-a",
    contractRevision: 1,
    ownerIdentifier: "owner-1",
    sourceRequestReference: "user-message-1",
    requirementBases: [],
    lastPotentialValue: 1,
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
      goalIdentifier: "goal-a",
      contractRevision: 1,
      completedGroupCount: 1,
      checksSinceLastReduction: 0,
      lastPotentialValue: null,
      bestPotentialValue: null,
      isPaused: false,
      pauseReason: null,
      evidenceGaps: [],
      consumedToolCalls: 0,
      requiresReplanning: false,
    },
    updatedAtIso: "2026-10-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("evaluateGoalPauseConditions", () => {
  it("未声明任何条件 ⇒ 不暂停（即使预算已耗尽）", () => {
    const decision = evaluateGoalPauseConditions({
      contract: buildContract(),
      state: buildState({ consumedToolCalls: 99 }),
      nowIso: "2026-10-31T00:00:00.000Z",
    });
    expect(decision.shouldPause).toBe(false);
    expect(decision.triggeredConditions).toEqual([]);
  });

  it("budget-exhausted：工具调用达上限触发", () => {
    const decision = evaluateGoalPauseConditions({
      contract: buildContract({ pauseConditions: ["budget-exhausted"] }),
      state: buildState({ consumedToolCalls: 10 }),
      nowIso: "2026-10-31T00:00:00.000Z",
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.triggeredConditions).toContain("budget-exhausted");
    expect(decision.reasons.join("；")).toContain("工具调用预算");
  });

  it("budget-exhausted：成本达上限触发", () => {
    const decision = evaluateGoalPauseConditions({
      contract: buildContract({ pauseConditions: ["budget-exhausted"] }),
      state: buildState({ consumedCostUnits: 5 }),
      nowIso: "2026-10-31T00:00:00.000Z",
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.reasons.join("；")).toContain("成本预算");
  });

  it("deadline-passed：超过截止时间触发", () => {
    const decision = evaluateGoalPauseConditions({
      contract: buildContract({
        pauseConditions: ["deadline-passed"],
        deadlineIso: "2026-10-30T00:00:00.000Z",
      }),
      state: buildState(),
      nowIso: "2026-10-31T00:00:00.000Z",
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.triggeredConditions).toContain("deadline-passed");
  });

  it("stagnation：检查次数达阈值触发", () => {
    const state = buildState();
    const decision = evaluateGoalPauseConditions({
      contract: buildContract({ pauseConditions: ["stagnation"] }),
      state: {
        ...state,
        gateSnapshot: { ...state.gateSnapshot, checksSinceLastReduction: 3 },
      },
      nowIso: "2026-10-31T00:00:00.000Z",
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.triggeredConditions).toContain("stagnation");
  });

  it("requires-replanning：状态标记需要重规划时触发", () => {
    const decision = evaluateGoalPauseConditions({
      contract: buildContract({ pauseConditions: ["requires-replanning"] }),
      state: buildState({ requiresReplanning: true }),
      nowIso: "2026-10-31T00:00:00.000Z",
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.triggeredConditions).toContain("requires-replanning");
  });
});

describe("validateGoalContract 暂停条件白名单", () => {
  it("未知暂停条件 ⇒ 契约非法", () => {
    const validation = validateGoalContract(
      buildContract({ pauseConditions: ["等我心情好了"] }),
    );
    expect(validation.isValid).toBe(false);
    if (!validation.isValid) {
      expect(validation.reasons.join("；")).toContain("未知的暂停条件");
    }
  });

  it("已知暂停条件 ⇒ 合法", () => {
    const validation = validateGoalContract(
      buildContract({
        pauseConditions: ["budget-exhausted", "deadline-passed", "stagnation"],
      }),
    );
    expect(validation.isValid).toBe(true);
  });
});
