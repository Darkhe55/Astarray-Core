/**
 * 协作消息 → 反馈消息的信封标记（2026-11-15，COMM-01 裁决第 1 条的功能侧）。
 *
 * 回复路由需要 `missionIdentifier`（定位任务链）与 `replyToMessageIdentifier`（指回原请求）。
 * 如果发送侧不标记，接收侧回复必然被拒绝——规则就永远无法实际使用。
 * 本文件钉住"发送侧真的标记了"，以及"没提供时保持旧形状"。
 */
import { describe, expect, it } from "vitest";

import { buildCollaborationFeedbackMessage } from "../../../packages/core/src/orchestration/collaboration-feedback-mapping.js";
import type { CollaborationInboxMessage } from "../../../packages/core/src/orchestration/collaboration-inbox.js";

function buildMessage(overrides: Partial<CollaborationInboxMessage> = {}): CollaborationInboxMessage {
  return {
    messageIdentifier: "message-1",
    correlationIdentifier: "corr-1",
    recipientAgentInstanceId: "agent-b1",
    senderAgentInstanceId: "agent-a1",
    originalSourceAgentInstanceId: "agent-a1",
    isRelayedRequest: false,
    taskIdentifier: "task-1",
    artifactReferenceStatus: "not-provided",
    summary: "请查询状态",
    receivedAtIso: "2026-11-15T00:00:00.000Z",
    authorizationEpoch: 1,
    state: "received",
    deliveryAttemptCount: 0,
    lastFailureAtIso: null,
    ...overrides,
  } as unknown as CollaborationInboxMessage;
}

describe("协作消息的信封标记", () => {
  it("① 带 mission ⇒ 反馈消息信封上带 missionIdentifier（回复时才能定位任务链）", () => {
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message: buildMessage({ missionIdentifier: "mission-1" }),
      sourceAgentRole: "secondary",
    });
    expect(feedbackMessage.missionIdentifier).toBe("mission-1");
  });

  it("② 带 replyTo ⇒ 信封上带 replyToMessageIdentifier（回复必须指回原请求）", () => {
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message: buildMessage({ replyToMessageIdentifier: "message-original" }),
      sourceAgentRole: "secondary",
    });
    expect(feedbackMessage.replyToMessageIdentifier).toBe("message-original");
  });

  it("③ 未提供时字段保持缺省（旧消息形状不变，不塞 null 冒充）", () => {
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message: buildMessage(),
      sourceAgentRole: "secondary",
    });
    expect(feedbackMessage.missionIdentifier).toBeUndefined();
    expect(feedbackMessage.replyToMessageIdentifier).toBeUndefined();
  });

  it("④ 显式 null 同样按「未提供」处理（不把 null 写进信封）", () => {
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message: buildMessage({ missionIdentifier: null, replyToMessageIdentifier: null }),
      sourceAgentRole: "secondary",
    });
    expect(feedbackMessage.missionIdentifier).toBeUndefined();
    expect(feedbackMessage.replyToMessageIdentifier).toBeUndefined();
  });
});
