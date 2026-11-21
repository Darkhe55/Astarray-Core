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

  /**
   * COORD-02 §7「生产与传输」：**关系标识**必须随反馈映射原样传递。
   *
   * 只带代际、不带关系标识时，接收侧无法回到权威存储复核（`authorization-missing`），
   * 于是这条消息永远投不出去——不是可选优化。
   */
  it("⑤ 带 authorizationIdentifier ⇒ 信封上带同一关系标识（接收侧才能复核当前代）", () => {
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message: buildMessage({ authorizationIdentifier: "authorization-1", authorizationEpoch: 2 }),
      sourceAgentRole: "secondary",
    });
    expect(
      (feedbackMessage as { authorizationIdentifier?: string }).authorizationIdentifier,
    ).toBe("authorization-1");
    expect(feedbackMessage.payload).toMatchObject({ authorizationEpoch: 2 });
  });

  it("⑥ 缺省 / 空串 / null ⇒ 信封上不出现关系标识（不伪造空章）", () => {
    for (const value of [undefined, null, "", "   "]) {
      const feedbackMessage = buildCollaborationFeedbackMessage({
        message: buildMessage({ authorizationIdentifier: value as string | null | undefined }),
        sourceAgentRole: "secondary",
      });
      expect(
        (feedbackMessage as { authorizationIdentifier?: string }).authorizationIdentifier,
      ).toBeUndefined();
    }
  });

  /**
   * 2026-11-21：`messageId` 必须是 **UUID**（`feedbackMessageSchema` 的硬约束）。
   *
   * 此前是 `"collaboration:" + messageIdentifier` ⇒ 反馈进程 `safeParse` 直接判非法，
   * 协作消息从未真正入池。改为从 messageIdentifier **确定性派生** UUID：
   * - 同一标识重试 ⇒ 同一 messageId（重放去重仍成立）；
   * - 不同标识 ⇒ 不同 messageId（不会串消息）。
   */
  it("⑦ messageId 为确定性 UUID：同标识稳定、不同标识不同", () => {
    const first = buildCollaborationFeedbackMessage({
      message: buildMessage(),
      sourceAgentRole: "secondary",
    });
    const again = buildCollaborationFeedbackMessage({
      message: buildMessage(),
      sourceAgentRole: "secondary",
    });
    const other = buildCollaborationFeedbackMessage({
      message: buildMessage({ messageIdentifier: "message-2" }),
      sourceAgentRole: "secondary",
    });
    expect(first.messageId).toBe(again.messageId);
    expect(first.messageId).not.toBe(other.messageId);
    expect(first.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
