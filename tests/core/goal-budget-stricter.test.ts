/**
 * R77（2026-10-31）：K11 "预算取更严" 的单测。
 *
 * 只测门禁：目标级上限、外部任务预算、两者都有时取较小值；
 * 以及外部预算为空时只按目标上限。
 */
import { describe, expect, it } from "vitest";

import { GoalDispatchGate } from "../../packages/core/src/orchestration/goal-dispatch-gate.js";
import type { GoalContract } from "../../packages/core/src/orchestration/goal-contract.js";

function buildContract(maximumToolCalls: number | null): GoalContract {
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
      maximumToolCalls,
      maximumWallClockSeconds: null,
      maximumCostUnits: null,
    },
    deadlineIso: null,
    pauseConditions: [],
    supersedesRevision: null,
  };
}

function check(gate: GoalDispatchGate, consumedToolCalls: number) {
  gate.recordToolCallConsumed(consumedToolCalls);
  return gate.assertMissionDispatchAllowed({
    requestedContractRevision: 1,
    projectIdentifier: "",
    nowIso: "2026-10-31T00:00:00.000Z",
  });
}

describe("目标门禁预算取更严（K11）", () => {
  it("只有目标上限：达到即拒绝", () => {
    const gate = new GoalDispatchGate(buildContract(10));
    const verdict = check(gate, 10);
    expect(verdict.isAllowed).toBe(false);
    if (!verdict.isAllowed) {
      expect(verdict.detail).toContain("目标预算");
    }
  });

  it("外部预算更小：按外部值拒绝，并注明来源", () => {
    const gate = new GoalDispatchGate(buildContract(10));
    gate.applyExternalBudgetLimit({ maximumToolCalls: 4, source: "任务预算" });
    const verdict = check(gate, 4);
    expect(verdict.isAllowed).toBe(false);
    if (!verdict.isAllowed) {
      expect(verdict.detail).toContain("取更严");
      expect(verdict.detail).toContain("任务预算");
    }
  });

  it("目标上限更小：仍按目标值拒绝（外部不放松）", () => {
    const gate = new GoalDispatchGate(buildContract(3));
    gate.applyExternalBudgetLimit({ maximumToolCalls: 100, source: "任务预算" });
    const verdict = check(gate, 3);
    expect(verdict.isAllowed).toBe(false);
    if (!verdict.isAllowed) {
      expect(verdict.detail).toContain("目标预算");
    }
  });

  it("清除外部预算后只按目标上限（未达目标上限 ⇒ 允许）", () => {
    const gate = new GoalDispatchGate(buildContract(10));
    gate.applyExternalBudgetLimit({ maximumToolCalls: 2, source: "任务预算" });
    gate.applyExternalBudgetLimit({ maximumToolCalls: null, source: "任务预算" });
    const verdict = check(gate, 5);
    expect(verdict.isAllowed).toBe(true);
  });

  it("契约无上限但有外部预算：按外部值拒绝", () => {
    const gate = new GoalDispatchGate(buildContract(null));
    gate.applyExternalBudgetLimit({ maximumToolCalls: 3, source: "任务预算" });
    const verdict = check(gate, 3);
    expect(verdict.isAllowed).toBe(false);
  });
});
