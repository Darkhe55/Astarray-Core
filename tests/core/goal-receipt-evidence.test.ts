/**
 * R82（2026-10-31）：确定性判据证据（完成收据）的单测。
 *
 * 覆盖：`deterministic-check` 谓词 + 验证收据 ⇒ valid（evidenceKind=deterministic-check）；
 * 无收据且无裁决 ⇒ unverified；`independent-acceptance` 谓词仍只认 accepted 裁决；
 * 有 accepted 裁决 ⇒ evidenceKind=independent-acceptance（来源如实标注）。
 */
import { describe, expect, it } from "vitest";

import { assessGoalRequirementsFromLocalState } from "../../packages/core/src/orchestration/goal-requirement-assessment.js";
import type { GoalContract } from "../../packages/core/src/orchestration/goal-contract.js";

function buildContract(
  kind: "deterministic-check" | "independent-acceptance",
): GoalContract {
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
        completionPredicateKind: kind,
        taskNodeIdentifiers: ["T-001"],
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
  };
}

describe("确定性判据证据（验证收据）", () => {
  it("deterministic-check + 验证收据 ⇒ valid（来源=deterministic-check）", () => {
    const assessments = assessGoalRequirementsFromLocalState({
      contract: buildContract("deterministic-check"),
      missionTaskStatusByTaskIdentifier: new Map([["T-001", "done"]]),
      taskIdentifiersWithAcceptedVerdict: new Set(),
      taskIdentifiersWithVerifiedReceipt: new Set(["T-001"]),
    });
    expect(assessments[0]?.evidence.kind).toBe("valid");
    if (assessments[0]?.evidence.kind === "valid") {
      expect(assessments[0].evidence.evidenceKind).toBe("deterministic-check");
      expect(assessments[0].evidence.evidenceReference).toContain("completion-receipt:");
    }
  });

  it("deterministic-check 但无收据、无裁决 ⇒ unverified", () => {
    const assessments = assessGoalRequirementsFromLocalState({
      contract: buildContract("deterministic-check"),
      missionTaskStatusByTaskIdentifier: new Map([["T-001", "done"]]),
      taskIdentifiersWithAcceptedVerdict: new Set(),
    });
    expect(assessments[0]?.evidence.kind).toBe("unverified");
  });

  it("independent-acceptance 谓词：只有收据不算证据", () => {
    const assessments = assessGoalRequirementsFromLocalState({
      contract: buildContract("independent-acceptance"),
      missionTaskStatusByTaskIdentifier: new Map([["T-001", "done"]]),
      taskIdentifiersWithAcceptedVerdict: new Set(),
      taskIdentifiersWithVerifiedReceipt: new Set(["T-001"]),
    });
    expect(assessments[0]?.evidence.kind).toBe("unverified");
  });

  it("有 accepted 裁决 ⇒ 来源标为 independent-acceptance", () => {
    const assessments = assessGoalRequirementsFromLocalState({
      contract: buildContract("independent-acceptance"),
      missionTaskStatusByTaskIdentifier: new Map([["T-001", "done"]]),
      taskIdentifiersWithAcceptedVerdict: new Set(["T-001"]),
    });
    expect(assessments[0]?.evidence.kind).toBe("valid");
    if (assessments[0]?.evidence.kind === "valid") {
      expect(assessments[0].evidence.evidenceKind).toBe("independent-acceptance");
    }
  });
});
