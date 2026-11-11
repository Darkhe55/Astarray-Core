/**
 * COORD-01-02（卡 §3）：**三状态只读视图**。
 *
 * 反例优先：
 * - 禁止用一个布尔代表三态：结果必须同时含 delivery / application / context 三个字段；
 * - 未应用的消息 `applicationState.state` 必须是 `pending`，**不能因为已投递就算 applied**；
 * - 未知消息 ⇒ 空数组，不伪造记录。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-status-view-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function seed(journal: MailboxJournal, messageId = "message-1") {
  await journal.enqueue({
    protocolVersion: 1,
    messageId,
    source: { sourceType: "agent", agentInstanceId: "worker-1" },
    recipientId: "agent:main-agent-1",
    priority: "state",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: messageId,
    payload: { kind: "success", summary: "完成" },
  } as never);
}

describe("消息三状态视图", () => {
  it("① 未投递未应用 ⇒ delivery=false、application=pending、context=not-required", async () => {
    const journal = new MailboxJournal(stateDirectory);
    await seed(journal);
    const [view] = await journal.readMessageStatusView({ recipientId: "agent:main-agent-1" });
    expect(view?.deliveryState.isDelivered).toBe(false);
    expect(view?.applicationState.state).toBe("pending");
    expect(view?.contextDeliveryState).toBe("not-required");
  });

  it("② 已投递但未应用 ⇒ 两个状态**分开**（投递不等于应用）", async () => {
    const journal = new MailboxJournal(stateDirectory);
    await seed(journal);
    await journal.markDelivered("agent:main-agent-1", "message-1", "2026-11-11T00:00:05.000Z");
    const [view] = await journal.readMessageStatusView({ recipientId: "agent:main-agent-1" });
    expect(view?.deliveryState.isDelivered).toBe(true);
    expect(view?.applicationState.state).toBe("pending");
  });

  it("③ 已应用 ⇒ application=applied 且带目标版本；blocked 必须带原因", async () => {
    const journal = new MailboxJournal(stateDirectory);
    await seed(journal);
    await journal.recordApplicationState({
      recipientId: "agent:main-agent-1",
      messageId: "message-1",
      state: "applied",
      targetStateVersion: 3,
      updatedAtIso: "2026-11-11T00:00:06.000Z",
    });
    const [applied] = await journal.readMessageStatusView({ recipientId: "agent:main-agent-1" });
    expect(applied?.applicationState.state).toBe("applied");
    expect(applied?.applicationState.targetStateVersion).toBe(3);

    await seed(journal, "message-2");
    await journal.recordApplicationState({
      recipientId: "agent:main-agent-1",
      messageId: "message-2",
      state: "blocked",
      reason: "stale",
      updatedAtIso: "2026-11-11T00:00:07.000Z",
    });
    const blocked = await journal.readMessageStatusView({
      recipientId: "agent:main-agent-1",
      messageId: "message-2",
    });
    expect(blocked[0]?.applicationState.state).toBe("blocked");
    expect(blocked[0]?.applicationState.reason).toBe("stale");
  });

  it("④ 未知消息 ⇒ 空数组（不伪造）", async () => {
    const journal = new MailboxJournal(stateDirectory);
    await seed(journal);
    expect(
      await journal.readMessageStatusView({ recipientId: "agent:main-agent-1", messageId: "missing" }),
    ).toEqual([]);
    expect(await journal.readMessageStatusView({ recipientId: "agent:unknown" })).toEqual([]);
  });
});
