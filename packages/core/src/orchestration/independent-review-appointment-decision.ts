/**
 * ALIGN-03-01 返修（2026-11-18）：**任命必须绑定权威任务版本**。
 *
 * 此前 `onTaskCompletedForIndependentReview` 里写死 `taskRevision: 1`。
 * 任务链推进到 2 之后，任命仍然声称"基于版本 1"——这是**伪造版本**，
 * 与"不得伪造版本/授权"的硬要求冲突。
 *
 * 规则：读得到任务链 ⇒ 用它当前的 revision；读不到 ⇒ **不任命**（如实上报），
 * 不回退到 1、不猜。
 */
export type IndependentReviewAppointmentDecision =
  | { readonly kind: "appoint"; readonly taskRevision: number }
  | { readonly kind: "refused"; readonly reason: string };

export function decideIndependentReviewAppointment(
  taskChain: { readonly revision: number } | null,
): IndependentReviewAppointmentDecision {
  if (taskChain === null) {
    return {
      kind: "refused",
      reason: "读不到任务链：无法确定任务版本，不任命（不伪造版本）",
    };
  }
  if (!Number.isInteger(taskChain.revision) || taskChain.revision <= 0) {
    return {
      kind: "refused",
      reason: `任务链 revision 非法（${String(taskChain.revision)}）：不任命（不伪造版本）`,
    };
  }
  return { kind: "appoint", taskRevision: taskChain.revision };
}
