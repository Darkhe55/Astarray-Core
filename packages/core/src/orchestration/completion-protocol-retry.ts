/**
 * R115（2026-11-01）：**完成控制协议缺失的有界重试**（纯判定）。
 *
 * 真实 Provider 偶尔不在末行输出 `ASTARRAY_TASK_COMPLETION_V1`（模型不守约），
 * 门禁按设计拒绝结案。直接失败会让任务"看起来做完了却被判失败"；
 * 这里允许**有界重试一次**：仅当门禁要求完成事件、失败原因正是"缺少完成事件"、
 * 且本任务尚未重试过时，才把任务重新排队。
 *
 * 不重试的情况（保持现状）：其它失败原因、未要求完成事件、已重试过。
 */
export const COMPLETION_PROTOCOL_RETRY_LIMIT = 1;

export interface CompletionProtocolRetryDecision {
  readonly shouldRetry: boolean;
  readonly reason: string | null;
}

export function shouldRetryCompletionProtocolFailure(input: {
  readonly failureReason: string;
  readonly attemptCount: number;
  readonly isCompletionProtocolRequired: boolean;
  /** R115：本任务已通过其它机制重试过（早停续跑/权限重跑）⇒ 不再叠加协议重试。 */
  readonly hasOtherRetry?: boolean;
  readonly limit?: number;
}): CompletionProtocolRetryDecision {
  if (!input.isCompletionProtocolRequired) {
    return { shouldRetry: false, reason: null };
  }
  if (input.hasOtherRetry === true) {
    return { shouldRetry: false, reason: null };
  }
  const limit = input.limit ?? COMPLETION_PROTOCOL_RETRY_LIMIT;
  if (input.attemptCount >= limit) {
    return { shouldRetry: false, reason: null };
  }
  const isMissingCompletionEvent =
    input.failureReason.includes("缺少 ASTARRAY_TASK_COMPLETION_V1") ||
    input.failureReason.includes("完成控制事件");
  if (!isMissingCompletionEvent) {
    return { shouldRetry: false, reason: null };
  }
  return {
    shouldRetry: true,
    reason: `缺少完成控制事件：有界重试（第 ${String(input.attemptCount + 1)}/${String(limit)} 次）`,
  };
}
