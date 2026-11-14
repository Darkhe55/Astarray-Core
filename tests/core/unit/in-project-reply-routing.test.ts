/**
 * 项目内回复路由（2026-11-14，COMM-01 裁决第 1 条，A+B 口径）。
 *
 * 每条用例对应一种"靠推断走捷径"的写法被拒绝的形态。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateInProjectReplyRouting,
} from "../../../packages/core/src/orchestration/in-project-reply-routing.js";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    messageIdentifier: "reply-1",
    senderIdentifier: "worker-1",
    recipientIdentifier: "dispatcher-1",
    replyToMessageIdentifier: "original-1",
    taskIdentifier: "task-1",
    ...overrides,
  } as never;
}

function original(overrides: Record<string, unknown> = {}) {
  return {
    messageIdentifier: "original-1",
    senderIdentifier: "dispatcher-1",
    recipientIdentifier: "worker-1",
    taskIdentifier: "task-1",
    ...overrides,
  } as never;
}

describe("项目内回复路由", () => {
  it("① 有原消息 + 同任务 + 收件人是派发者 ⇒ 允许，并给出原路径", () => {
    const decision = evaluateInProjectReplyRouting({
      candidate: candidate(),
      originalDeliveredMessage: original(),
      taskDispatcherIdentifier: "dispatcher-1",
    });
    expect(decision.kind).toBe("allowed");
    if (decision.kind !== "allowed") throw new Error("unreachable");
    expect(decision.pathIdentifier).toBe("task-1->dispatcher-1");
  });

  it("② 没有 replyTo ⇒ 拒绝（不按当前通信对象推断）", () => {
    const decision = evaluateInProjectReplyRouting({
      candidate: candidate({ replyToMessageIdentifier: null }),
      originalDeliveredMessage: original(),
      taskDispatcherIdentifier: "dispatcher-1",
    });
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("unreachable");
    expect(decision.reasonCode).toBe("reply-without-original");
  });

  it("③ 原消息查不到 ⇒ 拒绝（不得凭任务 id 自行猜收件人）", () => {
    const decision = evaluateInProjectReplyRouting({
      candidate: candidate(),
      originalDeliveredMessage: null,
      taskDispatcherIdentifier: "dispatcher-1",
    });
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("unreachable");
    expect(decision.reasonCode).toBe("reply-without-original");
  });

  it("④ 收件人不是原消息发起者 ⇒ 拒绝（不得改投）", () => {
    const decision = evaluateInProjectReplyRouting({
      candidate: candidate({ recipientIdentifier: "someone-else" }),
      originalDeliveredMessage: original(),
      taskDispatcherIdentifier: "dispatcher-1",
    });
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("unreachable");
    expect(decision.reasonCode).toBe("reply-target-mismatch");
  });

  it("⑤ 未标记当前任务 ⇒ 拒绝（A 的半边不能省）", () => {
    const decision = evaluateInProjectReplyRouting({
      candidate: candidate({ taskIdentifier: null }),
      originalDeliveredMessage: original(),
      taskDispatcherIdentifier: "dispatcher-1",
    });
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("unreachable");
    expect(decision.reasonCode).toBe("reply-without-task");
  });

  it("⑥ 声明的任务与原消息任务不一致 ⇒ 拒绝（跨任务不得直回）", () => {
    const decision = evaluateInProjectReplyRouting({
      candidate: candidate({ taskIdentifier: "task-2" }),
      originalDeliveredMessage: original(),
      taskDispatcherIdentifier: "dispatcher-1",
    });
    expect(decision.kind).toBe("rejected");
    if (decision.kind !== "rejected") throw new Error("unreachable");
    expect(decision.reasonCode).toBe("reply-original-mismatch");
  });

  it("⑦ 任务派发者未知 ⇒ 拒绝；派发者与收件人不一致 ⇒ 拒绝", () => {
    const unknownDispatcher = evaluateInProjectReplyRouting({
      candidate: candidate(),
      originalDeliveredMessage: original(),
      taskDispatcherIdentifier: null,
    });
    expect(unknownDispatcher.kind).toBe("rejected");
    if (unknownDispatcher.kind !== "rejected") throw new Error("unreachable");
    expect(unknownDispatcher.reasonCode).toBe("task-dispatcher-unknown");

    const mismatchedDispatcher = evaluateInProjectReplyRouting({
      candidate: candidate({ recipientIdentifier: "dispatcher-2" }),
      originalDeliveredMessage: original({ senderIdentifier: "dispatcher-2" }),
      taskDispatcherIdentifier: "dispatcher-1",
    });
    expect(mismatchedDispatcher.kind).toBe("rejected");
    if (mismatchedDispatcher.kind !== "rejected") throw new Error("unreachable");
    expect(mismatchedDispatcher.reasonCode).toBe("task-dispatcher-mismatch");
  });
});
