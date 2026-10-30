/**
 * R61/R62（2026-10-30）：**组性质的默认解析**（纯函数，便于单测）。
 *
 * 规则（与 ADR-0130 一致，刻意保守）：
 * - 宿主提供 `provider` ⇒ 用它；provider 抛错 ⇒ `normal`（诊断失败不改变停顿语义）；
 * - 未提供 ⇒ 本次要启动的任务中**任一**属于"返工"（`reworkedTaskIdentifiers`，
 *   由 retry/reassign/早停续跑写入）⇒ `rework`；否则 `normal`；
 * - **永不产生 `investigation`**：仓内没有该判定信号。
 */
import type { GoalGroupKind } from "./goal-dispatch-gate.js";

export interface GoalTaskGroupKindResolutionInput {
  readonly taskIdentifiers: readonly string[];
  readonly reworkedTaskIdentifiers: ReadonlySet<string>;
  readonly provider?: (input: {
    readonly taskIdentifiers: readonly string[];
  }) => GoalGroupKind;
}

export function resolveGoalTaskGroupKind(
  input: GoalTaskGroupKindResolutionInput,
): GoalGroupKind {
  const provider = input.provider;
  if (provider !== undefined) {
    try {
      return provider({ taskIdentifiers: [...input.taskIdentifiers] });
    } catch {
      return "normal";
    }
  }
  return input.taskIdentifiers.some((taskIdentifier) =>
    input.reworkedTaskIdentifiers.has(taskIdentifier),
  )
    ? "rework"
    : "normal";
}
