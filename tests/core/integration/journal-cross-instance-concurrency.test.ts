/**
 * 邮箱日志跨实例并发（2026-11-18）。
 *
 * 日志是投递/确认的持久依据：两个进程同时入队时，只靠各自的进程内队列
 * 会互相覆盖（丢消息 = 漏投递）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";
import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "journal-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildJournal(): MailboxJournal {
  return new MailboxJournal(stateDirectory);
}

function buildMessage(sequence: number): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: `message-${String(sequence)}`,
    source: { sourceType: "system", sourceIdentifier: "test", componentName: "test" },
    recipientId: "scheduler:mission-1",
    priority: "result",
    createdAtIso: "2026-11-18T00:00:00.000Z",
    idempotencyKey: `mission-1/${String(sequence)}`,
    payload: { kind: "success", summary: `结果 ${String(sequence)}` },
  } as unknown as FeedbackMessage;
}

describe("邮箱日志跨实例并发", () => {
  it("① 两个实例并发入队 40 条 ⇒ 日志里恰好 40 条", async () => {
    const firstJournal = buildJournal();
    const secondJournal = buildJournal();
    const enqueues: Promise<number>[] = [];
    for (let index = 0; index < 20; index += 1) {
      enqueues.push(
        firstJournal.enqueue(buildMessage(index * 2)),
        secondJournal.enqueue(buildMessage(index * 2 + 1)),
      );
    }
    await Promise.all(enqueues);

    const pendingCount = await buildJournal().countPending("scheduler:mission-1");
    expect(pendingCount).toBe(40);
  }, 90_000);

  it("② 同一幂等键被两个实例并发入队 ⇒ 只保留一条", async () => {
    const firstJournal = buildJournal();
    const secondJournal = buildJournal();
    const duplicate = { ...buildMessage(1) };
    await Promise.all([
      firstJournal.enqueue(duplicate),
      secondJournal.enqueue(buildMessage(1)),
    ]);
    expect(await buildJournal().countPending("scheduler:mission-1")).toBe(1);
  }, 90_000);
});
