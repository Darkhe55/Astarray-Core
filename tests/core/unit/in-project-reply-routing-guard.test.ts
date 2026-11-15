/**
 * 项目内回复路由守卫默认实现（2026-11-14）。
 *
 * 重点钉住一条与"普通反馈"不同的语义：**回复不接受回退**。
 * 任务没记录发布者时，普通反馈可以回退到默认信箱并如实说明；
 * 回复必须拒绝——回退就是"按默认对象推断去向"。
 */
import { describe, expect, it, vi } from "vitest";

import { createInProjectReplyRoutingGuard } from "../../../packages/core/src/orchestration/in-project-reply-routing-guard.js";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";

const DEFAULT_SCHEDULER = "scheduler-default";

function buildMessage(overrides: Record<string, unknown> = {}): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: "reply-1",
    source: { sourceType: "agent", agentInstanceId: "worker-1", agentRole: "worker" },
    recipientId: "dispatcher-1",
    priority: "normal",
    createdAtIso: "2026-11-14T00:00:00.000Z",
    idempotencyKey: "idem-reply-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    replyToMessageIdentifier: "original-1",
    payload: { kind: "status-update", summary: "进展" },
    ...overrides,
  } as unknown as FeedbackMessage;
}

function originalMessage(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "original-1",
    recipientId: "worker-1",
    taskIdentifier: "task-1",
    source: { sourceType: "agent", agentInstanceId: "dispatcher-1" },
    ...overrides,
  } as never;
}

describe("项目内回复守卫默认实现", () => {
  it("① 任务记录了发布者 + 收件人即发布者 ⇒ 放行", async () => {
    const guard = createInProjectReplyRoutingGuard({
      resolveTask: async () => ({ publishedByRecipientId: "dispatcher-1" }),
      defaultSchedulerRecipientIdentifierForMission: () => DEFAULT_SCHEDULER,
    });
    await expect(
      guard({ message: buildMessage(), findDeliveredMessage: async () => originalMessage() }),
    ).resolves.toBeUndefined();
  });

  it("② 任务未记录发布者 ⇒ **拒绝**（回退对回复不成立）", async () => {
    const guard = createInProjectReplyRoutingGuard({
      resolveTask: async () => ({ publishedByRecipientId: null }),
      defaultSchedulerRecipientIdentifierForMission: () => DEFAULT_SCHEDULER,
    });
    await expect(
      guard({ message: buildMessage(), findDeliveredMessage: async () => originalMessage() }),
    ).rejects.toThrow(/task-dispatcher-unknown/u);
  });

  it("③ 找不到任务 ⇒ 拒绝", async () => {
    const guard = createInProjectReplyRoutingGuard({
      resolveTask: async () => null,
      defaultSchedulerRecipientIdentifierForMission: () => DEFAULT_SCHEDULER,
    });
    await expect(
      guard({ message: buildMessage(), findDeliveredMessage: async () => originalMessage() }),
    ).rejects.toThrow(/找不到任务/u);
  });

  it("④ 原消息不存在 ⇒ 拒绝", async () => {
    const guard = createInProjectReplyRoutingGuard({
      resolveTask: async () => ({ publishedByRecipientId: "dispatcher-1" }),
      defaultSchedulerRecipientIdentifierForMission: () => DEFAULT_SCHEDULER,
    });
    await expect(
      guard({ message: buildMessage(), findDeliveredMessage: async () => null }),
    ).rejects.toThrow(/reply-without-original/u);
  });

  it("⑤ 收件人不是原消息发起者 ⇒ 拒绝（不得改投）", async () => {
    const guard = createInProjectReplyRoutingGuard({
      resolveTask: async () => ({ publishedByRecipientId: "dispatcher-1" }),
      defaultSchedulerRecipientIdentifierForMission: () => DEFAULT_SCHEDULER,
    });
    await expect(
      guard({
        message: buildMessage({ recipientId: "someone-else" }),
        findDeliveredMessage: async () => originalMessage(),
      }),
    ).rejects.toThrow(/reply-target-mismatch/u);
  });

  it("⑥ 缺少 mission 标识 ⇒ 拒绝（无法定位任务链）", async () => {
    const guard = createInProjectReplyRoutingGuard({
      resolveTask: async () => ({ publishedByRecipientId: "dispatcher-1" }),
      defaultSchedulerRecipientIdentifierForMission: () => DEFAULT_SCHEDULER,
    });
    await expect(
      guard({
        message: buildMessage({ missionIdentifier: undefined }),
        findDeliveredMessage: async () => originalMessage(),
      }),
    ).rejects.toThrow(/缺少 mission/u);
  });

  it("⑦ 非回复消息不归本守卫管（直接返回，不查任务）", async () => {
    const resolveTask = vi.fn(async () => ({ publishedByRecipientId: "dispatcher-1" }));
    const guard = createInProjectReplyRoutingGuard({
      resolveTask,
      defaultSchedulerRecipientIdentifierForMission: () => DEFAULT_SCHEDULER,
    });
    await guard({
      message: buildMessage({ replyToMessageIdentifier: undefined }),
      findDeliveredMessage: async () => null,
    });
    expect(resolveTask).not.toHaveBeenCalled();
  });
});
