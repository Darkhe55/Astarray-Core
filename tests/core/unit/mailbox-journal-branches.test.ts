/**
 * D8 / 覆盖补测（2026-11-23）：MailboxJournal 的**重放去重、应用状态与上下文状态**分支。
 *
 * 覆盖此前未命中的路径：重放存储（同内容/异内容/记录与邮箱不一致）、
 * 幂等键异内容拒绝、回复路由守卫缺失/被调用、
 * recordApplicationState 的 applied/idempotent-replay/ignored-stale/not-found、
 * 未知收件人计数与空目录列举。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";
import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-journal-branches-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let sequence = 0;

function makeMessage(overrides: Partial<FeedbackMessage> = {}): FeedbackMessage {
  sequence += 1;
  return {
    protocolVersion: 1,
    messageId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    source: { sourceType: "agent", agentInstanceId: `worker-${sequence}`, agentRole: "tertiary" },
    recipientId: "scheduler-1",
    priority: "success",
    createdAtIso: "2026-11-23T00:00:00.000Z",
    idempotencyKey: `mission-1/scheduler-1/${sequence}`,
    payload: { kind: "success", summary: `消息 ${sequence}` },
    ...overrides,
  } as FeedbackMessage;
}

function recordingReplayStore() {
  const deliveries = new Map<string, { originalResult: unknown; occurrenceCount: number }>();
  return {
    deliveries,
    findDelivered: async (messageIdentifier: string) =>
      deliveries.get(messageIdentifier) ?? null,
    recordDelivery: async (input: { messageIdentifier: string; incomingResult: unknown }) => {
      const existing = deliveries.get(input.messageIdentifier);
      const occurrenceCount = (existing?.occurrenceCount ?? 0) + 1;
      deliveries.set(input.messageIdentifier, {
        originalResult: input.incomingResult,
        occurrenceCount,
      });
      return { isDuplicate: existing !== undefined, result: input.incomingResult, occurrenceCount };
    },
  };
}

describe("MailboxJournal：重放去重", () => {
  it("① 同 messageId 同内容重放 ⇒ 递增计数但不重复入库", async () => {
    const store = recordingReplayStore();
    const journal = new MailboxJournal(baseDirectory, { replayDedupeStore: store });
    const message = makeMessage();
    const first = await journal.enqueue(message);
    const second = await journal.enqueue(message);
    expect(second).toBe(first);
    expect(store.deliveries.get(message.messageId)?.occurrenceCount).toBe(2);
    expect(await journal.countPending("scheduler-1")).toBe(1);
  });

  it("② 同 messageId 不同内容 ⇒ operation-not-idempotent（拒绝静默去重）", async () => {
    const store = recordingReplayStore();
    const journal = new MailboxJournal(baseDirectory, { replayDedupeStore: store });
    const message = makeMessage();
    await journal.enqueue(message);
    await expect(
      journal.enqueue({
        ...message,
        payload: { kind: "failure", failureReason: "不同内容", currentStateSummary: "测试" },
      }),
    ).rejects.toMatchObject({ errorCode: "operation-not-idempotent" });
  });

  it("③ 有重放记录但邮箱内没有该消息 ⇒ operation-not-idempotent（状态不一致）", async () => {
    const store = recordingReplayStore();
    const journal = new MailboxJournal(baseDirectory, { replayDedupeStore: store });
    const message = makeMessage();
    await journal.enqueue(message);
    /** 删掉邮箱文件：重放记录仍在，消息却不在 ⇒ 状态不一致，必须报错而不是静默重发。 */
    await fs.rm(
      path.join(baseDirectory, "feedback", "mailboxes", "scheduler-1.json"),
      { force: true },
    );
    await expect(journal.enqueue(message)).rejects.toMatchObject({
      errorCode: "operation-not-idempotent",
    });
  });

  it("④ 同幂等键异内容 ⇒ 拒绝；同幂等键同内容 ⇒ 返回原序号", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const message = makeMessage({ idempotencyKey: "fixed-key" });
    const first = await journal.enqueue(message);
    expect(await journal.enqueue({ ...message, messageId: "another-id" })).toBe(first);
    await expect(
      journal.enqueue({
        ...message,
        messageId: "third-id",
        payload: { kind: "failure", failureReason: "异内容", currentStateSummary: "测试" },
      }),
    ).rejects.toMatchObject({ errorCode: "operation-not-idempotent" });
  });
});

describe("MailboxJournal：回复路由守卫", () => {
  it("⑤ 未装配守卫的回复 ⇒ 明确拒绝（不按通信对象推断收件人）", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await expect(
      journal.enqueue(makeMessage({ replyToMessageIdentifier: "00000000-0000-4000-8000-000000000001" })),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });

  it("⑥ 已装配守卫 ⇒ 被调用，且能查到回复方邮箱里的原消息", async () => {
    const original = makeMessage();
    const journal = new MailboxJournal(baseDirectory, {
      replyRoutingGuard: async ({ message, findDeliveredMessage }) => {
        const found = await findDeliveredMessage(message.replyToMessageIdentifier as string);
        if (found === null) {
          throw new Error("原消息不存在");
        }
      },
    });
    await journal.enqueue(original);
    /** 原消息收件人是 scheduler-1；回复方是发件人 worker-N，其邮箱里没有原消息 ⇒ 守卫应拒绝。 */
    await expect(
      journal.enqueue(
        makeMessage({
          source: original.source,
          replyToMessageIdentifier: original.messageId,
        }),
      ),
    ).rejects.toThrow(/原消息不存在/);
  });
});

describe("MailboxJournal：应用状态与上下文状态", () => {
  it("⑦ applied → idempotent-replay → ignored-stale → not-found", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const message = makeMessage();
    await journal.enqueue(message);
    const first = await journal.recordApplicationState({
      recipientId: "scheduler-1",
      messageId: message.messageId,
      state: "applied",
      targetStateVersion: 2,
      updatedAtIso: "2026-11-23T00:00:00.000Z",
    });
    expect(first.outcome).toBe("applied");
    const replay = await journal.recordApplicationState({
      recipientId: "scheduler-1",
      messageId: message.messageId,
      state: "applied",
      targetStateVersion: 2,
      updatedAtIso: "2026-11-23T00:00:01.000Z",
    });
    expect(replay.outcome).toBe("idempotent-replay");
    const stale = await journal.recordApplicationState({
      recipientId: "scheduler-1",
      messageId: message.messageId,
      state: "applied",
      targetStateVersion: 1,
      updatedAtIso: "2026-11-23T00:00:02.000Z",
    });
    expect(stale.outcome).toBe("ignored-stale");
    const missingMessage = await journal.recordApplicationState({
      recipientId: "scheduler-1",
      messageId: "00000000-0000-4000-8000-999999999999",
      state: "applied",
      updatedAtIso: "2026-11-23T00:00:03.000Z",
    });
    expect(missingMessage.outcome).toBe("not-found");
    const missingRecipient = await journal.recordApplicationState({
      recipientId: "no-such-mailbox",
      messageId: message.messageId,
      state: "applied",
      updatedAtIso: "2026-11-23T00:00:04.000Z",
    });
    expect(missingRecipient.outcome).toBe("not-found");
  });

  it("⑧ 上下文注入状态：命中写回、未知收件人/消息静默返回", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const message = makeMessage();
    await journal.enqueue(message);
    await journal.setContextDeliveryState({
      recipientId: "scheduler-1",
      messageId: message.messageId,
      contextDeliveryState: "delivered",
    });
    await journal.setContextDeliveryState({
      recipientId: "scheduler-1",
      messageId: "00000000-0000-4000-8000-999999999999",
      contextDeliveryState: "delivered",
    });
    await journal.setContextDeliveryState({
      recipientId: "no-such-mailbox",
      messageId: message.messageId,
      contextDeliveryState: "delivered",
    });
    expect(await journal.countPending("no-such-mailbox")).toBe(0);
  });

  it("⑨ 空目录列举 ⇒ 空数组；有邮箱文件 ⇒ 解码收件人 ID", async () => {
    const empty = new MailboxJournal(baseDirectory);
    expect(await empty.listRecipientIds()).toEqual([]);
    await empty.enqueue(makeMessage());
    expect(await empty.listRecipientIds()).toEqual(["scheduler-1"]);
  });
});
