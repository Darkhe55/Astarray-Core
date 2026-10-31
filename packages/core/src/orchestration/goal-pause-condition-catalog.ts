/**
 * R76（2026-10-31）：**可评估的暂停条件清单**（K6）。
 *
 * 背景：契约里的 `pauseConditions` 是自由文本，无法机械评估（卡 02 明确把这列为缺口）。
 * 这里把它收窄为**有限枚举**：只有列在这里的条件会被评估；未知字符串由契约校验拒绝，
 * 避免"写了条件但其实没人看"。
 */

export const GOAL_PAUSE_CONDITIONS = [
  /** 工具调用/成本/时长预算耗尽。 */
  "budget-exhausted",
  /** 超过契约截止时间。 */
  "deadline-passed",
  /** 连续多次进展检查 V 未下降。 */
  "stagnation",
  /** 证据失效导致需要重新规划。 */
  "requires-replanning",
] as const;

export type GoalPauseCondition = (typeof GOAL_PAUSE_CONDITIONS)[number];

const KNOWN_PAUSE_CONDITIONS = new Set<string>(GOAL_PAUSE_CONDITIONS);

export function isKnownGoalPauseCondition(value: string): boolean {
  return KNOWN_PAUSE_CONDITIONS.has(value);
}
