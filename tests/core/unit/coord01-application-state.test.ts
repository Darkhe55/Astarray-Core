/**
 * COORD-01-02：**应用状态**与投递状态分离，且应用幂等。
 *
 * 反例优先（卡内 §3/§4.4）：
 * - 同 messageId 同目标版本重复上报 ⇒ 不重复计数（idempotent-replay）；
 * - 目标版本**低于**已应用版本 ⇒ `ignored-stale`，**不改动**已应用结论；
 * - 未入库消息 ⇒ `not-found`（不得凭空创建应用记录）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-journal-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function seedMessage(journal: MailboxJournal, messageId = "message-1") {
  await journal.enqueue({
    protocolVersion: 1,
    messageId,
    source: { sourceType: "agent", agentInstanceId: "agent-a" },
    recipientId: "agent-b",
    priority: "state",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: messageId,
    payload: { kind: "success", summary: "完成" },
  } as never);
}

describe("应用状态幂等记录", () => {
  it("① 首次上报 ⇒ applied，且 delivered 仍为 false（投递与分离）", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await seedMessage(journal);
    const outcome = await journal.recordApplicationState({
      recipientId: "agent-b",
      messageId: "message-1",
      state: "applied",
      targetStateVersion: 1,
      updatedAtIso: "2026-11-11T00:00:01.000Z",
    });
    expect(outcome.outcome).toBe("applied");
    const document = await journal.loadDocument("agent-b");
    const message = document?.messages.find((candidate) => candidate.messageId === "message-1");
    expect(message?.delivered).toBe(false);
    expect(message?.applicationState?.state).toBe("applied");
    expect(message?.applicationState?.attemptCount).toBe(1);
  });

  it("② 同版本重复上报 ⇒ idempotent-replay，不重复计数", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await seedMessage(journal);
    const input = {
      recipientId: "agent-b",
      messageId: "message-1",
      state: "applied" as const,
      targetStateVersion: 1,
      updatedAtIso: "2026-11-11T00:00:01.000Z",
    };
    await journal.recordApplicationState(input);
    const replay = await journal.recordApplicationState(input);
    expect(replay.outcome).toBe("idempotent-replay");
    const document = await journal.loadDocument("agent-b");
    expect(
      document?.messages.find((candidate) => candidate.messageId === "message-1")?.applicationState
        ?.attemptCount,
    ).toBe(1);
  });

  it("③ 目标版本更低 ⇒ ignored-stale，且已应用结论不被覆盖", async () => {
    const journal = new MailboxJournal(baseDirectory);
    await seedMessage(journal);
    await journal.recordApplicationState({
      recipientId: "agent-b",
      messageId: "message-1",
      state: "applied",
      targetStateVersion: 5,
      updatedAtIso: "2026-11-11T00:00:01.000Z",
    });
    const stale = await journal.recordApplicationState({
      recipientId: "agent-b",
      messageId: "message-1",
      state: "rejected",
      targetStateVersion: 3,
      updatedAtIso: "2026-11-11T00:00:02.000Z",
    });
    expect(stale.outcome).toBe("ignored-stale");
    const document = await journal.loadDocument("agent-b");
    const state = document?.messages.find((candidate) => candidate.messageId === "message-1")
      ?.applicationState;
    expect(state?.state).toBe("applied");
    expect(state?.targetStateVersion).toBe(5);
  });

  it("④ 未入库消息 ⇒ not-found", async () => {
    const journal = new MailboxJournal(baseDirectory);
    const outcome = await journal.recordApplicationState({
      recipientId: "agent-b",
      messageId: "missing",
      state: "applied",
      targetStateVersion: 1,
      updatedAtIso: "2026-11-11T00:00:01.000Z",
    });
    expect(outcome.outcome).toBe("not-found");
  });
});
