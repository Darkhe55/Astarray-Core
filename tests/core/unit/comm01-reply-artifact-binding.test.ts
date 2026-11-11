/**
 * COMM-01-02 修正：**回复必须能绑定原任务产物**。
 *
 * 反例优先：
 * - 空产物标识 ⇒ 拒收（不允许占位产物）；
 * - 非法 revision（0 / 小数）⇒ 拒收；
 * - **无产物**的回复仍然合法（向后兼容，口头确认也要能发）；
 * - 合法产物 ⇒ 入箱保留，并透传进反馈载荷。
 */
import { describe, expect, it } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { buildCollaborationFeedbackMessage } from "../../../packages/core/src/orchestration/collaboration-feedback-mapping.js";

function buildInbox() {
  return new CollaborationInbox({ maximumPendingMessagesPerRecipient: 8 } as never);
}

function enqueueInput(overrides: Record<string, unknown> = {}) {
  return {
    messageIdentifier: "message-1",
    correlationIdentifier: "correlation-1",
    recipientAgentInstanceId: "agent-b",
    senderAgentInstanceId: "agent-a",
    taskIdentifier: "T-001",
    summary: "已完成",
    receivedAtIso: "2026-11-11T00:00:00.000Z",
    ...overrides,
  } as never;
}

describe("回复的产物绑定", () => {
  it("① 空产物标识 ⇒ 拒收", () => {
    const result = buildInbox().enqueue(
      enqueueInput({ artifactReferences: [{ artifactIdentifier: "  ", revision: 1 }] }),
    );
    expect(result.outcome).toBe("rejected-invalid");
    expect(result.reason).toContain("artifactIdentifier");
  });

  it("② revision 非法（0）⇒ 拒收", () => {
    const result = buildInbox().enqueue(
      enqueueInput({ artifactReferences: [{ artifactIdentifier: "src/a.ts", revision: 0 }] }),
    );
    expect(result.outcome).toBe("rejected-invalid");
    expect(result.reason).toContain("revision");
  });

  it("③ 无产物 ⇒ 仍然合法（向后兼容）", () => {
    const result = buildInbox().enqueue(enqueueInput());
    expect(result.outcome).not.toBe("rejected-invalid");
    expect(result.message?.artifactReferences).toBeUndefined();
  });

  it("④ 合法产物 ⇒ 入箱保留并透传进反馈载荷", () => {
    const result = buildInbox().enqueue(
      enqueueInput({ artifactReferences: [{ artifactIdentifier: "src/a.ts", revision: 3 }] }),
    );
    expect(result.message?.artifactReferences).toEqual([{ artifactIdentifier: "src/a.ts", revision: 3 }]);
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message: result.message as never,
      sourceAgentRole: "secondary" as never,
    });
    const payload = feedbackMessage.payload as { artifactReferences?: unknown };
    expect(payload.artifactReferences).toEqual([{ artifactIdentifier: "src/a.ts", revision: 3 }]);
  });
});
