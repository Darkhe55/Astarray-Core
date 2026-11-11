/**
 * COORD-01-02：规范信封的**归属键**（projectIdentifier / taskIdentifier）。
 *
 * 反例优先：
 * - 归属键必须随消息**持久**（不能只在内存里）；
 * - 同幂等键但归属不同 ⇒ 视为"同键异内容"，**拒绝**而不是静默复用；
 * - 旧消息缺归属键仍可入池（向后兼容），不得因缺字段崩溃。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-envelope-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    messageId: "message-1",
    source: { sourceType: "agent", agentInstanceId: "agent-a" },
    recipientId: "agent-b",
    priority: "state",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: "key-1",
    projectIdentifier: "project-alpha",
    taskIdentifier: "T-001",
    payload: { kind: "success", summary: "完成" },
    ...overrides,
  } as never;
}

describe("信封归属键", () => {
  it("① 归属键随消息持久化", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await journal.enqueue(buildMessage());
    const document = await journal.loadDocument("agent-b");
    expect(document?.messages[0]?.projectIdentifier).toBe("project-alpha");
    expect(document?.messages[0]?.taskIdentifier).toBe("T-001");
  });

  it("② 同幂等键但归属不同 ⇒ 拒绝（同键异内容）", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await journal.enqueue(buildMessage());
    await expect(
      journal.enqueue(buildMessage({ taskIdentifier: "T-002" })),
    ).rejects.toThrow(/同幂等键异内容/u);
  });

  it("③ 缺归属键仍可入池（兼容旧消息）", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await journal.enqueue(
      buildMessage({ idempotencyKey: "key-legacy", projectIdentifier: undefined, taskIdentifier: undefined }),
    );
    const document = await journal.loadDocument("agent-b");
    expect(document?.messages).toHaveLength(1);
    expect(document?.messages[0]?.taskIdentifier).toBeUndefined();
  });
});
