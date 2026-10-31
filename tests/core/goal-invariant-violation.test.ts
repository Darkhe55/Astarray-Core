/**
 * R78（2026-10-31）：K4 安全不变量（结构化 + 本地违规检出）的单测。
 *
 * 覆盖：只有声明的标识才被记录、记录后派发被拒且原因/缺口可见、
 * 未声明的违规不改变行为、契约校验拒绝未知标识。
 */
import { describe, expect, it } from "vitest";

import { GoalDispatchGate } from "../../packages/core/src/orchestration/goal-dispatch-gate.js";
import { validateGoalContract } from "../../packages/core/src/orchestration/goal-contract.js";
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

function checkDispatch(gate: GoalDispatchGate) {
  return gate.assertMissionDispatchAllowed({
    requestedContractRevision: 1,
    projectIdentifier: "",
    nowIso: "2026-10-31T00:00:00.000Z",
  });
}

describe("K4 安全不变量", () => {
  it("未声明的不变量违规不被记录，也不影响派发", () => {
    const gate = new GoalDispatchGate(buildContract());
    const recorded = gate.recordInvariantViolation({
      invariantCode: "tool.permission-denied",
      detail: "readFile: 被拒绝",
      recordedAtIso: "2026-10-31T00:00:00.000Z",
    });
    expect(recorded).toBe(false);
    expect(gate.getRecordedInvariantViolations()).toEqual([]);
    expect(checkDispatch(gate).isAllowed).toBe(true);
  });

  it("声明的标识被记录后 ⇒ 派发被拒，原因与缺口可见", () => {
    const gate = new GoalDispatchGate(
      buildContract({ nonViolableInvariants: ["tool.permission-denied"] }),
    );
    const recorded = gate.recordInvariantViolation({
      invariantCode: "tool.permission-denied",
      detail: "writeFile: 被拒绝",
      recordedAtIso: "2026-10-31T00:00:00.000Z",
    });
    expect(recorded).toBe(true);
    const verdict = checkDispatch(gate);
    expect(verdict.isAllowed).toBe(false);
    if (!verdict.isAllowed) {
      expect(verdict.reasonCode).toBe("safety-invariant-violated");
      expect(verdict.detail).toContain("tool.permission-denied");
      expect(verdict.evidenceGaps.length).toBeGreaterThan(0);
    }
  });

  it("不变量违规不因 V 下降而清除（与进展无关）", () => {
    const gate = new GoalDispatchGate(
      buildContract({ nonViolableInvariants: ["tool.permission-denied"] }),
    );
    gate.recordInvariantViolation({
      invariantCode: "tool.permission-denied",
      detail: "writeFile: 被拒绝",
      recordedAtIso: "2026-10-31T00:00:00.000Z",
    });
    gate.recordGroupCompletion({
      groupIdentifier: "group-1",
      outcome: "completed",
      groupKind: "normal",
      potentialValueAfterGroup: 0,
      recordedBy: "local-verifier",
      recordedAtIso: "2026-10-31T00:01:00.000Z",
    });
    const verdict = checkDispatch(gate);
    expect(verdict.isAllowed).toBe(false);
    expect(gate.getRecordedInvariantViolations()).toHaveLength(1);
  });

  it("持久化恢复：只接受已声明标识，恢复后派发被拒", () => {
    const gate = new GoalDispatchGate(
      buildContract({ nonViolableInvariants: ["tool.permission-denied"] }),
    );
    gate.restoreInvariantViolations([
      {
        invariantCode: "tool.permission-denied",
        detail: "writeFile: 拒绝",
        recordedAtIso: "2026-10-31T00:00:00.000Z",
      },
      {
        invariantCode: "installation.gate",
        detail: "未声明的标识应被忽略",
        recordedAtIso: "2026-10-31T00:00:01.000Z",
      },
    ]);
    expect(gate.getRecordedInvariantViolations()).toHaveLength(1);
    expect(checkDispatch(gate).isAllowed).toBe(false);
  });

  it("契约校验：未知不变量标识被拒，已知标识合法", () => {
    const invalid = validateGoalContract(
      buildContract({ nonViolableInvariants: ["不要写坏东西"] }),
    );
    expect(invalid.isValid).toBe(false);

    const valid = validateGoalContract(
      buildContract({
        nonViolableInvariants: ["tool.permission-denied", "installation.gate"],
      }),
    );
    expect(valid.isValid).toBe(true);
  });
});
