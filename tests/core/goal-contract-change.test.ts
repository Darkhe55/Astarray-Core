/**
 * R71（2026-10-30）：契约变更校验（K3）的单测。
 *
 * 只测纯函数 `validateGoalContractChange`：来源合法性、标识/所有者/来源引用不可变、
 * revision 严格 +1、supersedesRevision 指向被替代版本、总权重不变。
 */
import { describe, expect, it } from "vitest";

import {
  validateGoalContractChange,
} from "../../packages/core/src/orchestration/goal-contract.js";
import type { GoalContract } from "../../packages/core/src/orchestration/goal-contract.js";

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

function buildNextContract(overrides: Partial<GoalContract> = {}): GoalContract {
  return buildContract({ revision: 2, supersedesRevision: 1, ...overrides });
}

describe("validateGoalContractChange", () => {
  it("合法变更（来源=发布方、revision+1、supersedes 正确、总权重不变）", () => {
    const result = validateGoalContractChange({
      previousContract: buildContract(),
      nextContract: buildNextContract(),
      proposer: "source-publisher",
    });
    expect(result.reasons).toEqual([]);
    expect(result.isAllowed).toBe(true);
  });

  it("模型提议一律拒绝", () => {
    const result = validateGoalContractChange({
      previousContract: buildContract(),
      nextContract: buildNextContract(),
      proposer: "model-proposal",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.reasons.join("；")).toContain("变更来源非法");
  });

  it("revision 不是恰好 +1 ⇒ 拒绝", () => {
    const result = validateGoalContractChange({
      previousContract: buildContract(),
      nextContract: buildNextContract({ revision: 3, supersedesRevision: 1 }),
      proposer: "authenticated-owner",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.reasons.join("；")).toContain("revision 必须恰好 +1");
  });

  it("supersedesRevision 不指向上一版 ⇒ 拒绝", () => {
    const result = validateGoalContractChange({
      previousContract: buildContract(),
      nextContract: buildNextContract({ supersedesRevision: null }),
      proposer: "authenticated-owner",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.reasons.join("；")).toContain("supersedesRevision");
  });

  it("更换 goalIdentifier / owner / 来源引用 ⇒ 拒绝", () => {
    for (const overrides of [
      { goalIdentifier: "goal-b" },
      { ownerIdentifier: "owner-2" },
      { sourceRequestReference: "user-message-2" },
    ] satisfies Partial<GoalContract>[]) {
      const result = validateGoalContractChange({
        previousContract: buildContract(),
        nextContract: buildNextContract(overrides),
        proposer: "authenticated-owner",
      });
      expect(result.isAllowed).toBe(false);
    }
  });

  it("降低总权重（降判准）⇒ 拒绝", () => {
    const next = buildNextContract({
      requirements: [
        {
          requirementIdentifier: "req-1",
          description: "写完说明",
          weight: 0.5,
          completionPredicateKind: "deterministic-check",
          taskNodeIdentifiers: [],
        },
      ],
    });
    const result = validateGoalContractChange({
      previousContract: buildContract(),
      nextContract: next,
      proposer: "authenticated-owner",
    });
    expect(result.isAllowed).toBe(false);
    expect(result.reasons.join("；")).toContain("总权重");
  });
});
