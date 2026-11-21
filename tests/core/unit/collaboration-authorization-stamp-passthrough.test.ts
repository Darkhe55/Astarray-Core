/**
 * COORD-02 §7「生产与传输」：授权章（关系标识 + 代际）随**反馈信封**原样传递。
 *
 * 背景（2026-11-21 施工）：生产侧盖章（`enqueueWithAuthoritativeStamp`）已把章写进收件箱，
 * 消费侧（`deliverWithAuthoritativeAuthorization`）也按权威存储复核；但**传输层**
 * （`buildCollaborationFeedbackMessage` / `CollaborationOutboxTransport` / `feedbackMessageSchema`）
 * 此前只带代际、不带关系标识。结果：消息一旦经过映射/发件箱/反馈进程校验，关系标识就丢了，
 * 接收侧无法回到权威存储核对"这是哪条授权关系"，消费侧一律判 `authorization-missing`。
 *
 * 本文件钉住三件事：
 * 1. 有章 ⇒ 校验与持久化后仍带着**同一个**关系标识（zod 不得静默剥离）；
 * 2. 无章 ⇒ 不注入 null / 空串（不把"没有"伪装成"已盖章"）；
 * 3. 空串 ⇒ 校验失败（空串不是有效章，fail-closed）。
 *
 * 说明：这里用 `instruction` 载荷，只验证**信封层**的透传契约，与具体载荷种类无关。
 * 协作请求载荷走反馈进程还有既有缺口（见 COORD-02 卡"仍未做"），不在本反例范围。
 */
import { describe, expect, it } from "vitest";

import { feedbackMessageSchema } from "../../../packages/core/src/core/schemas.js";
import { buildCollaborationFeedbackMessage } from "../../../packages/core/src/orchestration/collaboration-feedback-mapping.js";
import type { CollaborationInboxMessage } from "../../../packages/core/src/orchestration/collaboration-inbox.js";

const MESSAGE_ID = "3f1c8a52-6d47-4d0e-9a3b-2c5e7f8a1b64";

function buildFeedbackMessage(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    messageId: MESSAGE_ID,
    source: { sourceType: "agent", agentInstanceId: "agent-a1", agentRole: "secondary" },
    recipientId: "agent:agent-b1",
    priority: "instruction",
    createdAtIso: "2026-11-21T00:00:00.000Z",
    idempotencyKey: "message-1",
    payload: { kind: "instruction", instructionText: "核对构建日志" },
    ...extra,
  };
}

/** 经过一次 JSON 往返，等价于"写入队列/邮件箱后再读回"。 */
function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function carriedIdentifierOf(parsed: unknown): string | undefined {
  return (parsed as { authorizationIdentifier?: string }).authorizationIdentifier;
}

describe("反馈信封的授权章透传", () => {
  it("① 带关系标识 ⇒ 校验（JSON 往返后）仍带着同一个标识", () => {
    const parsed = feedbackMessageSchema.parse(
      jsonRoundTrip(buildFeedbackMessage({ authorizationIdentifier: "authorization-1" })),
    );
    expect(carriedIdentifierOf(parsed)).toBe("authorization-1");
  });

  it("② 不带关系标识 ⇒ 校验通过且字段缺省（不注入 null/空串冒充已盖章）", () => {
    const parsed = feedbackMessageSchema.parse(jsonRoundTrip(buildFeedbackMessage()));
    expect(carriedIdentifierOf(parsed)).toBeUndefined();
  });

  it("③ 空串关系标识 ⇒ 校验失败（空串不得成为有效章）", () => {
    const result = feedbackMessageSchema.safeParse(
      jsonRoundTrip(buildFeedbackMessage({ authorizationIdentifier: "" })),
    );
    expect(result.success).toBe(false);
  });

  it("④ 未知字段不会被当成章：伪造的 payload.authorizationIdentifier 不生效", () => {
    const message = buildFeedbackMessage();
    (message["payload"] as Record<string, unknown>)["authorizationIdentifier"] =
      "authorization-forged";
    const parsed = feedbackMessageSchema.parse(jsonRoundTrip(message));
    expect(carriedIdentifierOf(parsed)).toBeUndefined();
    expect(
      (parsed.payload as unknown as Record<string, unknown>)["authorizationIdentifier"],
    ).toBeUndefined();
  });

  /**
   * 2026-11-21：协作映射产出的**整封**消息必须能通过 `feedbackMessageSchema`。
   *
   * 此前两处硬冲突把它挡在门外：`PRIORITY_OF_KIND` 没有 `collaboration-request`，
   * 且 `messageId` 是 `collaboration:<id>` 不满足 uuid。结果是反馈进程逐条拒绝。
   */
  it("⑤ 协作映射产出的信封整体通过 schema，且关系标识/代际都在", () => {
    const inboxMessage = {
      messageIdentifier: "message-1",
      correlationIdentifier: "corr-1",
      recipientAgentInstanceId: "agent-b1",
      senderAgentInstanceId: "agent-a1",
      originalSourceAgentInstanceId: "agent-a1",
      isRelayedRequest: false,
      taskIdentifier: "task-1",
      artifactReferenceStatus: "not-provided",
      summary: "请查询状态",
      receivedAtIso: "2026-11-21T00:00:00.000Z",
      authorizationEpoch: 2,
      authorizationIdentifier: "authorization-1",
      state: "received",
      deliveryAttemptCount: 0,
      lastFailureAtIso: null,
    } as unknown as CollaborationInboxMessage;
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message: inboxMessage,
      sourceAgentRole: "secondary",
    });
    const parsed = feedbackMessageSchema.safeParse(jsonRoundTrip(feedbackMessage));
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(carriedIdentifierOf(parsed.data)).toBe("authorization-1");
    expect(parsed.data.payload).toMatchObject({ authorizationEpoch: 2 });
  });

  /**
   * 2026-11-21：既有信封字段同样不能被静默剥离。
   *
   * `mission/replyTo` 丢失 ⇒ 回复路由失败；`taskRevision/executionAttempt` 丢失 ⇒
   * "版本不符/旧尝试"永远测不出来。它们此前都没登记进 schema。
   */
  it("⑥ mission/task/replyTo/版本/执行尝试经 schema 后仍在", () => {
    const parsed = feedbackMessageSchema.parse(
      jsonRoundTrip(
        buildFeedbackMessage({
          projectIdentifier: "project-a",
          missionIdentifier: "mission-1",
          taskIdentifier: "task-1",
          replyToMessageIdentifier: "message-0",
          taskRevision: 3,
          executionAttempt: 2,
        }),
      ),
    );
    expect(parsed).toMatchObject({
      projectIdentifier: "project-a",
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      replyToMessageIdentifier: "message-0",
      taskRevision: 3,
      executionAttempt: 2,
    });
  });
});
