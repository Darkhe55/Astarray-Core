/**
 * R99（2026-11-01）：**每三组进展检查**的单测（卡验收"无进展能暂停"）。
 *
 * 规则：每 3 个已结束组检查一次；只有普通组参与停滞计数；返工/调查组不计入；
 * 连续 3 次检查 V 未下降 ⇒ 暂停自动派发。
 */
import { describe, expect, it } from "vitest";

import { GoalDispatchGate } from "../../packages/core/src/orchestration/goal-dispatch-gate.js";
import type { GoalContract } from "../../packages/core/src/orchestration/goal-contract.js";

function buildContract(): GoalContract {
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

function completeGroup(
  gate: GoalDispatchGate,
  index: number,
  potentialValue: number,
  groupKind: "normal" | "rework" | "investigation" = "normal",
) {
  return gate.recordGroupCompletion({
    groupIdentifier: `group-${String(index)}`,
    outcome: "completed",
    groupKind,
    potentialValueAfterGroup: potentialValue,
    recordedBy: "local-verifier",
    recordedAtIso: `2026-10-31T00:0${String(index)}:00.000Z`,
  });
}

describe("每三组进展检查与停滞暂停", () => {
  it("普通组连续三次检查 V 不降 ⇒ 暂停", () => {
    const gate = new GoalDispatchGate(buildContract());
    completeGroup(gate, 1, 2); // 首次无基准 ⇒ 建立 best
    completeGroup(gate, 2, 2); // 未到检查点
    const third = completeGroup(gate, 3, 2); // 首次检查：best 为空 ⇒ 视为下降，计数 0
    expect(third.checksSinceLastReduction).toBe(0);
    completeGroup(gate, 4, 2);
    completeGroup(gate, 5, 2);
    const sixth = completeGroup(gate, 6, 2); // 检查 1：未降
    expect(sixth.checksSinceLastReduction).toBe(1);
    completeGroup(gate, 7, 2);
    completeGroup(gate, 8, 2);
    completeGroup(gate, 9, 2); // 检查 2
    completeGroup(gate, 10, 2);
    completeGroup(gate, 11, 2);
    completeGroup(gate, 12, 2); // 检查 3 ⇒ 暂停
    expect(gate.getState().isPaused).toBe(true);
    expect(gate.getState().pauseReason ?? "").toContain("连续");
  });

  it("返工组不计入停滞（到达检查点也不算未降）", () => {
    const gate = new GoalDispatchGate(buildContract());
    completeGroup(gate, 1, 2);
    completeGroup(gate, 2, 2);
    const reworkCheck = completeGroup(gate, 3, 2, "rework");
    expect(reworkCheck.didRunProgressCheck).toBe(true);
    expect(reworkCheck.checksSinceLastReduction).toBe(0);
    expect(gate.getState().isPaused).toBe(false);
  });

  it("V 实际下降 ⇒ 检查计数清零", () => {
    const gate = new GoalDispatchGate(buildContract());
    completeGroup(gate, 1, 3);
    completeGroup(gate, 2, 3);
    const third = completeGroup(gate, 3, 3); // 首次检查建立 best=3
    expect(third.checksSinceLastReduction).toBe(0);
    completeGroup(gate, 4, 2);
    completeGroup(gate, 5, 2);
    const sixth = completeGroup(gate, 6, 2); // 2 < 3 ⇒ 下降，计数清零
    expect(sixth.checksSinceLastReduction).toBe(0);
    expect(gate.getState().isPaused).toBe(false);
  });

  it("非本地校验器记录被拒（模型不得伪造）", () => {
    const gate = new GoalDispatchGate(buildContract());
    expect(() =>
      gate.recordGroupCompletion({
        groupIdentifier: "group-x",
        outcome: "completed",
        groupKind: "normal",
        potentialValueAfterGroup: 1,
        recordedBy: "model" as never,
        recordedAtIso: "2026-10-31T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("调查组不计停滞（多组）", () => {
  it("连续 12 个 investigation 组、V 不降 ⇒ 不暂停、计数保持 0", () => {
    const gate = new GoalDispatchGate(buildContract());
    let lastChecks = 0;
    for (let index = 1; index <= 12; index += 1) {
      const result = completeGroup(gate, index, 2, "investigation");
      /** 到检查点时"检查执行但跳过计数"；非检查点不执行。 */
      expect(result.didRunProgressCheck).toBe(index % 3 === 0);
      expect(result.didPause).toBe(false);
      lastChecks = result.checksSinceLastReduction;
    }
    expect(lastChecks).toBe(0);
    /** 之后一个普通组检查仍从 0 开始（调查组不积累"未降"次数）。 */
    const normalAfter = completeGroup(gate, 13, 2, "normal");
    expect(normalAfter.didRunProgressCheck).toBe(false);
  });
});
