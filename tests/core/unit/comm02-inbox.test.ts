/**
 * COMM-01-02 §2.4 协作收件箱反例（2026-10-24）。
 *
 * 卡内要求原文（第 76 行）：
 * "接收、投递、已处理、业务完成为不同状态；重复投递复用回执，不重复插入任务。
 *  每收件人背压、有限重试、转发跳数和关联链循环检测复用现有机制。"
 * 第 78 行："关系变更与授权撤销后，在途旧消息不得落入新任务或新个体"。
 */
import { describe, expect, it } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";

function createInbox(overrides: Partial<{ maximumPendingPerRecipient: number; maximumDeliveryAttempts: number }> = {}) {
  return new CollaborationInbox({
    maximumPendingPerRecipient: overrides.maximumPendingPerRecipient ?? 3,
    maximumDeliveryAttempts: overrides.maximumDeliveryAttempts ?? 3,
  });
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageIdentifier: "message-1",
    correlationIdentifier: "corr-1",
    recipientAgentInstanceId: "agent-b",
    senderAgentInstanceId: "agent-a",
    taskIdentifier: "task-1",
    summary: "请协助核对构建日志",
    receivedAtIso: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("COMM-01-02 协作收件箱", () => {
  it("① 四态分离：接收 ≠ 投递 ≠ 已处理 ≠ 业务完成", () => {
    const inbox = createInbox();
    const enqueued = inbox.enqueue(message());
    expect(enqueued.outcome).toBe("accepted");
    expect(enqueued.message?.state).toBe("received");

    expect(inbox.markDelivered("message-1", "2026-10-24T00:00:05.000Z").isDelivered).toBe(true);
    expect(inbox.getMessage("message-1")?.state).toBe("delivered");
    expect(inbox.markProcessed("message-1", "2026-10-24T00:00:10.000Z").isProcessed).toBe(true);
    expect(inbox.getMessage("message-1")?.state).toBe("processed");
    expect(inbox.markCompleted("message-1", "2026-10-24T00:00:20.000Z").isCompleted).toBe(true);
    expect(inbox.getMessage("message-1")?.state).toBe("completed");
  });

  it("② 重复投递复用回执：不重复插入、返回同一回执", () => {
    const inbox = createInbox();
    const first = inbox.enqueue(message());
    const duplicate = inbox.enqueue(message({ summary: "重复投递" }));
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.isDuplicate).toBe(true);
    expect(duplicate.receipt?.messageIdentifier).toBe(first.message?.messageIdentifier);
    expect(inbox.listForRecipient("agent-b")).toHaveLength(1);
  });

  it("③ 每收件人背压：超过上限明确拒绝，不静默丢弃", () => {
    const inbox = createInbox({ maximumPendingPerRecipient: 1 });
    expect(inbox.enqueue(message({ messageIdentifier: "m-1" })).outcome).toBe("accepted");
    const rejected = inbox.enqueue(message({ messageIdentifier: "m-2", correlationIdentifier: "corr-2" }));
    expect(rejected.outcome).toBe("rejected-backpressure");
    expect(rejected.reason).toContain("背压");
    expect(inbox.listForRecipient("agent-b")).toHaveLength(1);
  });

  it("④ 有限重试：达到上限转失败并停止重试（不无限重试）", () => {
    const inbox = createInbox({ maximumDeliveryAttempts: 2 });
    inbox.enqueue(message());
    const firstFailure = inbox.recordDeliveryFailure("message-1", "2026-10-24T00:00:01.000Z");
    expect(firstFailure.isExhausted).toBe(false);
    expect(firstFailure.retryAfterSeconds).toBeGreaterThan(0);

    const secondFailure = inbox.recordDeliveryFailure("message-1", "2026-10-24T00:00:02.000Z");
    expect(secondFailure.isExhausted).toBe(true);
    expect(inbox.getMessage("message-1")?.state).toBe("failed");
    expect(secondFailure.retryAfterSeconds).toBeNull();
  });

  it("⑤ 转达跳数/环检测：超限或成环在入箱前拒绝", () => {
    const inbox = createInbox();
    const cycle = inbox.enqueue(
      message({
        messageIdentifier: "m-cycle",
        relayChain: { hopCount: 0, visitedAgentInstanceIds: ["agent-b"] },
      }),
    );
    expect(cycle.outcome).toBe("rejected-relay-chain");
    expect(cycle.reason).toContain("环");

    const tooManyHops = inbox.enqueue(
      message({ messageIdentifier: "m-hops", relayChain: { hopCount: 1 } }),
    );
    expect(tooManyHops.outcome).toBe("rejected-relay-chain");
  });

  it("⑥ 授权撤销后：在途旧消息不得落入新任务", () => {
    const inbox = createInbox();
    inbox.enqueue(message({ authorizationEpoch: 7 }));
    const stale = inbox.markDelivered("message-1", "2026-10-24T00:00:05.000Z", {
      currentAuthorizationEpoch: 8,
    });
    expect(stale.isDelivered).toBe(false);
    expect(stale.reason).toContain("授权已变更");
    expect(inbox.getMessage("message-1")?.state).toBe("received");
  });

  it("⑦ 状态只能前进：未投递不能标记已处理", () => {
    const inbox = createInbox();
    inbox.enqueue(message());
    const processed = inbox.markProcessed("message-1", "2026-10-24T00:00:10.000Z");
    expect(processed.isProcessed).toBe(false);
    expect(processed.reason).toContain("投递");
  });

  it("⑧ 其他收件人不被阻塞（忙碌隔离）", () => {
    const inbox = createInbox({ maximumPendingPerRecipient: 2 });
    inbox.enqueue(message({ messageIdentifier: "a-1", recipientAgentInstanceId: "agent-a", senderAgentInstanceId: "agent-x" }));
    inbox.enqueue(message({ messageIdentifier: "a-2", recipientAgentInstanceId: "agent-a", senderAgentInstanceId: "agent-x", correlationIdentifier: "corr-a2" }));
    const blockedForA = inbox.enqueue(
      message({ messageIdentifier: "a-3", recipientAgentInstanceId: "agent-a", senderAgentInstanceId: "agent-x", correlationIdentifier: "corr-a3" }),
    );
    expect(blockedForA.outcome).toBe("rejected-backpressure");
    const acceptedForB = inbox.enqueue(
      message({ messageIdentifier: "b-1", recipientAgentInstanceId: "agent-b", senderAgentInstanceId: "agent-x", correlationIdentifier: "corr-b1" }),
    );
    expect(acceptedForB.outcome).toBe("accepted");
  });
});


