/**
 * COMM-01-03 反例（2026-10-22）：mailbox journal 的**并发读改写丢更新**。
 *
 * 背景：验收脚本用 `fork` 跑真实反馈进程时发现
 *  - 并发入池若干条后，落盘文件少于入池数（丢消息）；
 *  - `ack` 之后进行中的投递又把消息写回（已确认的消息复活）。
 * 根因：`enqueue / markDelivered / ack` 都是「读文档 → 改 → 原子写回」，彼此没有串行化，
 * 并发时后者用旧的快照覆盖前者的结果（lost update）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";

const temporaryDirectories: string[] = [];

async function createJournal(): Promise<{ baseDirectory: string; journal: MailboxJournal }> {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-comm-concurrency-"));
  temporaryDirectories.push(baseDirectory);
  return { baseDirectory, journal: new MailboxJournal(baseDirectory) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function message(recipientId: string, index: number): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    source: { sourceType: "agent", agentInstanceId: "agent-a", agentRole: "main" },
    recipientId,
    priority: "instruction",
    createdAtIso: "2026-10-22T10:00:00.000Z",
    idempotencyKey: `idem-${String(index)}`,
    payload: { kind: "instruction", instructionText: `消息 ${String(index)}` },
  };
}

describe("COMM-01-03 mailbox journal 并发安全", () => {
  it("① 并发入池 3 条 ⇒ 三条都必须落盘（不丢更新）", async () => {
    const { journal } = await createJournal();
    await Promise.all([
      journal.enqueue(message("agent-b", 1)),
      journal.enqueue(message("agent-b", 2)),
      journal.enqueue(message("agent-b", 3)),
    ]);
    expect(await journal.countPending("agent-b")).toBe(3);
  });

  it("② 入池与投递标记并发 ⇒ 消息数与 delivered 状态都正确保留", async () => {
    const { journal } = await createJournal();
    const first = message("agent-b", 1);
    await journal.enqueue(first);
    const second = message("agent-b", 2);
    const third = message("agent-b", 3);
    await Promise.all([
      journal.enqueue(second),
      journal.markDelivered("agent-b", first.messageId, "2026-10-22T10:00:01.000Z"),
      journal.enqueue(third),
    ]);
    expect(await journal.countPending("agent-b")).toBe(3);
  });

  it("③ ack 与投递标记并发 ⇒ 已确认的消息不得复活", async () => {
    const { journal } = await createJournal();
    const first = message("agent-b", 1);
    const second = message("agent-b", 2);
    await journal.enqueue(first);
    await journal.enqueue(second);
    await journal.markDelivered("agent-b", first.messageId, "2026-10-22T10:00:01.000Z");
    // ack 与另一条消息的投递标记并发发生
    await Promise.all([
      journal.ack("agent-b", first.messageId),
      journal.markDelivered("agent-b", second.messageId, "2026-10-22T10:00:02.000Z"),
    ]);
    const pending = await journal.countPending("agent-b");
    expect(pending).toBe(1);
  });
});
