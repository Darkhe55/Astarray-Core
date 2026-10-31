/**
 * R76（2026-10-31）：**暂停条件评估**（K6 的纯逻辑）。
 *
 * 只看契约里**已声明且被收窄为枚举**的暂停条件；未声明的条件不评估。
 * 规则：
 * - `budget-exhausted`：`consumedToolCalls >= maximumToolCalls`，或
 *   `consumedCostUnits >= maximumCostUnits`（任一上限存在且达到）；
 * - `deadline-passed`：有截止时间且当前时间晚于它；
 * - `stagnation`：门禁快照的 `checksSinceLastReduction` 达到阈值（与门禁同一常量）；
 * - `requires-replanning`：状态已标记需要重规划。
 *
 * **只给建议**：调用方（组结束路径）决定是否 `gate.pause(...)` 并落状态。
 */
import { GOAL_STAGNATION_PAUSE_THRESHOLD_CHECKS } from "./goal-dispatch-gate.js";
import type { GoalContract } from "./goal-contract.js";
import type { PersistedGoalModeState } from "./goal-mode-store.js";

export interface GoalPauseConditionDecision {
  readonly shouldPause: boolean;
  readonly reasons: readonly string[];
  readonly triggeredConditions: readonly string[];
}

export function evaluateGoalPauseConditions(input: {
  readonly contract: GoalContract;
  readonly state: PersistedGoalModeState;
  readonly nowIso: string;
}): GoalPauseConditionDecision {
  const reasons: string[] = [];
  const triggeredConditions: string[] = [];
  const declaredConditions = new Set(input.contract.pauseConditions);
  const { contract, state } = input;

  if (declaredConditions.has("budget-exhausted")) {
    const maximumToolCalls = contract.resourceLimits.maximumToolCalls;
    const maximumCostUnits = contract.resourceLimits.maximumCostUnits;
    if (maximumToolCalls !== null && state.consumedToolCalls >= maximumToolCalls) {
      triggeredConditions.push("budget-exhausted");
      reasons.push(
        `工具调用预算已用尽（${String(state.consumedToolCalls)}/${String(maximumToolCalls)}）。`,
      );
    } else if (maximumCostUnits !== null && state.consumedCostUnits >= maximumCostUnits) {
      triggeredConditions.push("budget-exhausted");
      reasons.push(
        `成本预算已用尽（${String(state.consumedCostUnits)}/${String(maximumCostUnits)}）。`,
      );
    }
  }

  if (declaredConditions.has("deadline-passed") && contract.deadlineIso !== null) {
    const nowMilliseconds = Date.parse(input.nowIso);
    const deadlineMilliseconds = Date.parse(contract.deadlineIso);
    if (
      !Number.isNaN(nowMilliseconds) &&
      !Number.isNaN(deadlineMilliseconds) &&
      nowMilliseconds > deadlineMilliseconds
    ) {
      triggeredConditions.push("deadline-passed");
      reasons.push(`已超过目标截止时间（${contract.deadlineIso}）。`);
    }
  }

  if (
    declaredConditions.has("stagnation") &&
    state.gateSnapshot.checksSinceLastReduction >= GOAL_STAGNATION_PAUSE_THRESHOLD_CHECKS
  ) {
    triggeredConditions.push("stagnation");
    reasons.push(
      `连续 ${String(state.gateSnapshot.checksSinceLastReduction)} 次进展检查 V 未下降。`,
    );
  }

  if (declaredConditions.has("requires-replanning") && state.requiresReplanning) {
    triggeredConditions.push("requires-replanning");
    reasons.push("证据失效导致目标需要重新规划。");
  }

  return {
    shouldPause: reasons.length > 0,
    reasons,
    triggeredConditions,
  };
}
