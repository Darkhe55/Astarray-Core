/**
 * 项目内回复路由**接线**（2026-11-14，COMM-01 裁决第 1 条，A+B）。
 *
 * 钉住三件事：未装配守卫时带回复的消息必须**拒绝**（fail-closed）、
 * 装配后守卫能查到已入库的原消息、以及非回复消息行为完全不变。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { evaluateInProjectReplyRouting } from "../../../packages/core/src/orchestration/in-project-reply-routing.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-reply-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: `message-${Math.random().toString(36).slice(2)}`,
    source: { sourceType: "agent", agentInstanceId: "worker-1", agentRole: "worker" },
    recipientId: "dispatcher-1",
    priority: "normal",
    createdAtIso: "2026-11-14T00:00:00.000Z",
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    taskIdentifier: "task-1",
    payload: { kind: "status-update", summary: "进展" },
    ...overrides,
  } as never;
}

describe("项目内回复路由接线", () => {
  it("① 未装配守卫 + 带 replyTo ⇒ 拒绝（fail-closed，不按通信对象推断）", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await expect(
      journal.enqueue(buildMessage({ replyToMessageIdentifier: "original-1" })),
    ).rejects.toThrow(/回复路由守卫/u);
    expect(await journal.findMessageByIdentifier("dispatcher-1", "original-1")).toBeNull();
  });

  it("② 装配守卫 ⇒ 守卫被调用，且能查到已入库的原消息", async () => {
    const originalMessage = buildMessage({
      messageId: "original-1",
      source: { sourceType: "agent", agentInstanceId: "dispatcher-1", agentRole: "worker" },
      recipientId: "worker-1",
    });
    const guard = vi.fn(async (_input: unknown) => undefined);
    const journal = new MailboxJournal(baseDirectory, { replyRoutingGuard: guard });
    await journal.enqueue(originalMessage);

    const reply = buildMessage({ messageId: "reply-1", replyToMessageIdentifier: "original-1" });
    await journal.enqueue(reply);

    expect(guard).toHaveBeenCalledTimes(1);
    const guardInput = guard.mock.calls[0]?.[0] as unknown as {
      findDeliveredMessage: (id: string) => Promise<unknown>;
    };
    const found = await guardInput.findDeliveredMessage("original-1");
    expect(found).not.toBeNull();
  });

  it("③ 非回复消息不触发守卫（旧行为不变）", async () => {
    const guard = vi.fn(async (_input: unknown) => undefined);
    const journal = new MailboxJournal(baseDirectory, { replyRoutingGuard: guard });
    await journal.enqueue(buildMessage());
    expect(guard).not.toHaveBeenCalled();
  });

  it("④ 守卫拒绝 ⇒ 消息不入库（不得先落盘再报错）", async () => {
    const journal = new MailboxJournal(baseDirectory, {
      replyRoutingGuard: async () => {
        throw new Error("路径不合规");
      },
    });
    await expect(
      journal.enqueue(buildMessage({ messageId: "reply-2", replyToMessageIdentifier: "original-1" })),
    ).rejects.toThrow(/路径不合规/u);
    expect(await journal.findMessageByIdentifier("dispatcher-1", "reply-2")).toBeNull();
  });

  it("⑤ 守卫可以接真实判定：收件人不是派发者 ⇒ 拒绝", async () => {
    const journal = new MailboxJournal(baseDirectory, {
      replyRoutingGuard: async ({ message, findDeliveredMessage }) => {
        const original = await findDeliveredMessage(
          (message as { replyToMessageIdentifier?: string }).replyToMessageIdentifier ?? "",
        );
        const decision = evaluateInProjectReplyRouting({
          candidate: {
            messageIdentifier: (message as { messageId: string }).messageId,
            senderIdentifier: "worker-1",
            recipientIdentifier: (message as { recipientId: string }).recipientId,
            replyToMessageIdentifier:
              (message as { replyToMessageIdentifier?: string }).replyToMessageIdentifier ?? null,
            taskIdentifier: (message as { taskIdentifier?: string }).taskIdentifier ?? null,
          },
          originalDeliveredMessage:
            original === null
              ? null
              : {
                  messageIdentifier: (original as { messageId: string }).messageId,
                  senderIdentifier: "dispatcher-1",
                  recipientIdentifier: "worker-1",
                  taskIdentifier: "task-1",
                },
          taskDispatcherIdentifier: "dispatcher-1",
        });
        if (decision.kind === "rejected") {
          throw new Error(decision.reasonCode);
        }
      },
    });

    await journal.enqueue(
      buildMessage({
        messageId: "original-2",
        source: { sourceType: "agent", agentInstanceId: "dispatcher-1", agentRole: "worker" },
        recipientId: "worker-1",
      }),
    );
    await expect(
      journal.enqueue(
        buildMessage({
          messageId: "reply-3",
          recipientId: "someone-else",
          replyToMessageIdentifier: "original-2",
        }),
      ),
    ).rejects.toThrow(/reply-target-mismatch/u);
  });
});
