/**
 * 重放去重接线（2026-11-16，COMM-01 裁决第 2 条）。
 *
 * 钉住两件事：
 * 1. **同一 messageId 重放 ⇒ 静默去重、返回原序号、次数累加**（且不重复入库）；
 * 2. **同一 messageId 不同内容 ⇒ 拒绝**（不许静默吞掉一份）。
 *
 * 这两条合起来才叫"静默去重 + 带重复次数"：只去重不计数 ⇒ 无法观察重放；
 * 只计数不拒绝异内容 ⇒ 用同一个 id 掩盖两条不同消息。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommDeliveredMessageStore } from "../../../packages/core/src/orchestration/comm-delivered-message-store.js";
import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mailbox-replay-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "message-1",
    source: { sourceType: "agent", agentInstanceId: "worker-1", agentRole: "worker" },
    recipientId: "dispatcher-1",
    priority: "normal",
    createdAtIso: "2026-11-16T00:00:00.000Z",
    idempotencyKey: "idem-1",
    taskIdentifier: "task-1",
    payload: { kind: "status-update", summary: "进展" },
    ...overrides,
  } as never;
}

function buildJournal() {
  return new MailboxJournal(baseDirectory, {
    replayDedupeStore: new CommDeliveredMessageStore({ baseDirectory }),
  });
}

describe("重放去重接线", () => {
  it("① 首次入库 ⇒ 正常入队，并登记重放记录", async () => {
    const journal = buildJournal();
    const sequence = await journal.enqueue(buildMessage());
    expect(sequence).toBeDefined();
    const store = new CommDeliveredMessageStore({ baseDirectory });
    expect(await store.findDelivered("message-1")).not.toBeNull();
  });

  it("② 同 messageId 重放（即使换了 idempotencyKey）⇒ 静默去重、返回原序号、次数累加", async () => {
    const journal = buildJournal();
    const firstSequence = await journal.enqueue(buildMessage());
    const replaySequence = await journal.enqueue(
      buildMessage({ idempotencyKey: "idem-2" }),
    );

    expect(replaySequence).toBe(firstSequence);
    const store = new CommDeliveredMessageStore({ baseDirectory });
    /** 关键：次数必须真的累加（裁决要求"带重复次数"，不是布尔标记）。 */
    expect((await store.findDelivered("message-1"))?.occurrenceCount).toBe(2);
  });

  it("③ 同 messageId 但内容不同 ⇒ 拒绝（不得静默吞掉一份）", async () => {
    const journal = buildJournal();
    await journal.enqueue(buildMessage());
    await expect(
      journal.enqueue(buildMessage({ payload: { kind: "status-update", summary: "不同内容" } })),
    ).rejects.toThrow(/不同内容/u);
  });

  it("④ 不同 messageId 互不影响（不串档）", async () => {
    const journal = buildJournal();
    const firstSequence = await journal.enqueue(buildMessage());
    const secondSequence = await journal.enqueue(
      buildMessage({ messageId: "message-2", idempotencyKey: "idem-3" }),
    );
    expect(secondSequence).not.toBe(firstSequence);
  });

  it("⑤ 跨重启仍是重复（新 journal 实例 + 同一状态目录）", async () => {
    const firstJournal = buildJournal();
    const firstSequence = await firstJournal.enqueue(buildMessage());

    const restartedJournal = buildJournal();
    const replaySequence = await restartedJournal.enqueue(buildMessage());
    expect(replaySequence).toBe(firstSequence);
  });
});
