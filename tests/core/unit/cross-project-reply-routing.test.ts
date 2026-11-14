/**
 * COMM-01 回复路由：**回复必须沿原请求路径返回**（2026-11-14，用户裁决第 1 条）。
 *
 * 用户口径：agent 执行任务期间标记当前任务 id；发出的任务回复要**直接使用该任务 id 对应的原路径**，
 * 而不是它可能正在使用的对话/传呼对象。
 *
 * 跨项目通道里这是可验证的形态：
 * - `correlated-reply` 必须指明 `replyToMessageIdentifier`，且该消息确实在本机账本里存在；
 * - 回复的收件人必须是**原请求的发起者**（路径反向沿原路返回）；
 * - 以上任一不成立 ⇒ 拒绝，**不得**按当前通信对象/最新会话推断收件人。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateCrossProjectDelivery,
} from "../../../packages/core/src/orchestration/cross-project-collaboration.js";
import type {
  CrossProjectAuthorization,
  CrossProjectEnvelope,
} from "../../../packages/core/src/orchestration/cross-project-collaboration.js";

const NOW_ISO = "2026-11-14T12:00:00.000Z";

const AUTHORIZATION: CrossProjectAuthorization = {
  authorizationIdentifier: "auth-1",
  sourceProjectIdentifier: "project-a",
  targetProjectIdentifier: "project-b",
  requestingAgentInstanceId: "agent-a1",
  scope: { kind: "specific-agent", agentInstanceId: "agent-b1" },
  allowedMessageKinds: ["status-query", "correlated-reply"],
  purpose: "跨项目只读协作",
  issuedAtIso: "2026-11-14T00:00:00.000Z",
  expiresAtIso: "2027-01-01T00:00:00.000Z",
  revision: 3,
  isRevoked: false,
  isReadOnly: true,
  canBeRedelegated: false,
};

function buildEnvelope(overrides: Partial<CrossProjectEnvelope> = {}): CrossProjectEnvelope {
  return {
    messageIdentifier: "message-reply-1",
    idempotencyKey: "idem-reply-1",
    senderAgentInstanceId: "agent-a1",
    recipientAgentInstanceId: "agent-b1",
    sourceProjectIdentifier: "project-a",
    targetProjectIdentifier: "project-b",
    sourceSessionIdentifier: null,
    targetSessionIdentifier: null,
    missionIdentifier: null,
    taskIdentifier: "task-1",
    authorizationRevision: 3,
    messageKind: "correlated-reply",
    correlationIdentifier: "corr-1",
    replyToMessageIdentifier: "message-original-1",
    intendedAction: "read",
    ...overrides,
  };
}

function evaluateReply(input: {
  envelope?: Partial<CrossProjectEnvelope>;
  original?: {
    messageIdentifier: string;
    senderAgentInstanceId: string;
    recipientAgentInstanceId: string;
  } | null;
}) {
  return evaluateCrossProjectDelivery({
    envelope: buildEnvelope(input.envelope),
    authorization: AUTHORIZATION,
    nowIso: NOW_ISO,
    ...(input.original === undefined ? {} : { originalDeliveredMessage: input.original }),
  });
}

describe("跨项目回复路由", () => {
  it("① 回复沿原请求路径返回（收件人 = 原请求发起者）⇒ 允许", () => {
    const outcome = evaluateReply({
      original: {
        messageIdentifier: "message-original-1",
        senderAgentInstanceId: "agent-b1",
        recipientAgentInstanceId: "agent-a1",
      },
    });
    expect(outcome.kind).toBe("allowed");
  });

  it("② 找不到原请求 ⇒ 拒绝（不得按当前通信对象推断收件人）", () => {
    const outcome = evaluateReply({ original: null });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("reply-without-original");
  });

  it("③ 未声明 replyToMessageIdentifier ⇒ 拒绝（回复必须指向原请求）", () => {
    const outcome = evaluateReply({
      envelope: { replyToMessageIdentifier: null },
      original: {
        messageIdentifier: "message-original-1",
        senderAgentInstanceId: "agent-b1",
        recipientAgentInstanceId: "agent-a1",
      },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("reply-without-original");
  });

  it("④ 回复发给第三方（不是原请求发起者）⇒ 拒绝：不得改投", () => {
    const outcome = evaluateReply({
      envelope: { recipientAgentInstanceId: "agent-c9" },
      original: {
        messageIdentifier: "message-original-1",
        senderAgentInstanceId: "agent-b1",
        recipientAgentInstanceId: "agent-a1",
      },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.reasonCode).toBe("reply-target-mismatch");
  });

  it("⑤ 非回复消息（task-request）不受该规则影响", () => {
    const outcome = evaluateCrossProjectDelivery({
      envelope: buildEnvelope({
        messageKind: "status-query",
        replyToMessageIdentifier: null,
        senderAgentInstanceId: "agent-a1",
      }),
      authorization: AUTHORIZATION,
      nowIso: NOW_ISO,
    });
    expect(outcome.kind).toBe("allowed");
  });
});
