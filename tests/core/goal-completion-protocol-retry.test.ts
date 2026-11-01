/**
 * R115（2026-11-01）：完成控制协议缺失的有界重试 —— 判定单测。
 *
 * 只重试"要求完成事件 + 原因正是缺少完成事件 + 未超过上限"这一种情况。
 */
import { describe, expect, it } from "vitest";

import {
  COMPLETION_PROTOCOL_RETRY_LIMIT,
  shouldRetryCompletionProtocolFailure,
} from "../../packages/core/src/orchestration/completion-protocol-retry.js";

const MISSING_EVENT_REASON =
  "缺少 ASTARRAY_TASK_COMPLETION_V1 完成控制事件（本地完成门禁未通过）";

describe("完成控制协议有界重试", () => {
  it("要求完成事件 + 原因匹配 + 未重试 ⇒ 重试一次", () => {
    const decision = shouldRetryCompletionProtocolFailure({
      failureReason: MISSING_EVENT_REASON,
      attemptCount: 0,
      isCompletionProtocolRequired: true,
    });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.reason).toContain("有界重试");
    expect(COMPLETION_PROTOCOL_RETRY_LIMIT).toBe(1);
  });

  it("已重试过 ⇒ 不再重试", () => {
    const decision = shouldRetryCompletionProtocolFailure({
      failureReason: MISSING_EVENT_REASON,
      attemptCount: 1,
      isCompletionProtocolRequired: true,
    });
    expect(decision.shouldRetry).toBe(false);
  });

  it("未要求完成事件 ⇒ 不重试（mock/对话模式保持原行为）", () => {
    const decision = shouldRetryCompletionProtocolFailure({
      failureReason: MISSING_EVENT_REASON,
      attemptCount: 0,
      isCompletionProtocolRequired: false,
    });
    expect(decision.shouldRetry).toBe(false);
  });

  it("已通过早停续跑重试过 ⇒ 不再叠加协议重试（保持总次数有界）", () => {
    const decision = shouldRetryCompletionProtocolFailure({
      failureReason: MISSING_EVENT_REASON,
      attemptCount: 0,
      isCompletionProtocolRequired: true,
      hasOtherRetry: true,
    });
    expect(decision.shouldRetry).toBe(false);
  });

  it("其它失败原因 ⇒ 不重试", () => {
    const decision = shouldRetryCompletionProtocolFailure({
      failureReason: "工具 readFile 连续失败达到阈值",
      attemptCount: 0,
      isCompletionProtocolRequired: true,
    });
    expect(decision.shouldRetry).toBe(false);
  });
});
