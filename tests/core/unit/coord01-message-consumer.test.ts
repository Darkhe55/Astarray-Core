/**
 * COORD-01-02：协调消费步（入库 → 租约 → 短事务 → 回写应用状态 → 唤醒信号）。
 *
 * 反例优先：
 * - 消息被消费两次 ⇒ 只应用一次、只唤醒一次；
 * - 租约被他人持有 ⇒ 本步**一条都不处理**（不是"部分处理"）；
 * - 持有者死亡、租约过期 ⇒ 新消费者能接手（崩溃恢复语义）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { CoordinationMessageConsumer } from "../../../packages/core/src/orchestration/coordination-message-consumer.js";
import {
  CoordinationPartitionLeaseStore,
  buildCoordinationPartitionKey,
} from "../../../packages/core/src/orchestration/coordination-partition-lease.js";
import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";
import { CoordinationRetryStore } from "../../../packages/core/src/orchestration/coordination-retry-store.js";

let stateDirectory: string;
let partitionKey: string;
let nowUnixMilliseconds: number;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-consumer-"));
  partitionKey = buildCoordinationPartitionKey({
    projectIdentifier: "project-alpha",
    schedulerAgentInstanceIdentifier: "scheduler-1",
  });
  nowUnixMilliseconds = 1_700_000_000_000;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildHarness() {
  const journal = new MailboxJournal(path.join(stateDirectory, "journal"));
  const leaseStore = new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(stateDirectory, "leases"),
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  const stateStore = new CoordinationStateTransactionStore({
    stateDirectory: path.join(stateDirectory, "state"),
    leaseStore,
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  const consumer = new CoordinationMessageConsumer({
    journal,
    leaseStore,
    stateStore,
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  return { journal, leaseStore, stateStore, consumer };
}

async function enqueue(journal: MailboxJournal, messageId: string) {
  await journal.enqueue({
    protocolVersion: 1,
    messageId,
    source: { sourceType: "agent", agentInstanceId: "agent-a" },
    recipientId: "agent-b",
    priority: "state",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: messageId,
    projectIdentifier: "project-alpha",
    taskIdentifier: "T-001",
    payload: { kind: "success", summary: "完成" },
  } as never);
}

function stepInput(partitionKeyValue: string) {
  return {
    partitionKey: partitionKeyValue,
    recipientId: "agent-b",
    ownerInstanceIdentifier: "consumer-a",
    leaseTtlMilliseconds: 60_000,
    toSnapshot: (message: { messageId: string }) => ({ appliedMessage: message.messageId }),
  };
}

describe("协调消费步", () => {
  it("① 两条消息 ⇒ 都应用并请求一次唤醒", async () => {
    const { journal, consumer } = buildHarness();
    await enqueue(journal, "message-1");
    await enqueue(journal, "message-2");
    const result = await consumer.runConsumptionStep(stepInput(partitionKey));
    expect(result.appliedMessageCount).toBe(2);
    expect(result.isWakeRequested).toBe(true);
  });

  it("② 第二次消费 ⇒ 不再新增应用（幂等）", async () => {
    const { journal, consumer, stateStore } = buildHarness();
    await enqueue(journal, "message-1");
    await consumer.runConsumptionStep(stepInput(partitionKey));
    const second = await consumer.runConsumptionStep(stepInput(partitionKey));
    expect(second.appliedMessageCount).toBe(0);
    const state = await stateStore.readState(partitionKey);
    expect(state?.appliedMessages).toHaveLength(1);
  });

  it("③ 租约被他人持有 ⇒ 一条都不处理，消息仍待应用", async () => {
    const { journal, consumer, leaseStore } = buildHarness();
    await enqueue(journal, "message-1");
    await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "other-consumer",
      ttlMilliseconds: 60_000,
    });
    const result = await consumer.runConsumptionStep(stepInput(partitionKey));
    expect(result.isLeaseUnavailable).toBe(true);
    expect(result.attemptedMessageCount).toBe(0);
    expect(await journal.listPendingApplication("agent-b")).toHaveLength(1);
  });

  it("⑤ 已达退避上限的消息本轮跳过（§4.7 持久计数生效）", async () => {
    const { journal, consumer, leaseStore, stateStore } = buildHarness();
    await enqueue(journal, "message-1");
    const retryStore = new CoordinationRetryStore({
      stateDirectory: path.join(stateDirectory, "retry"),
      nowUnixMilliseconds: () => nowUnixMilliseconds,
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await retryStore.recordFailure({
        partitionKey,
        messageIdentifier: "message-1",
        reason: "stale",
      });
    }
    const consumerWithRetry = new CoordinationMessageConsumer({
      journal,
      leaseStore,
      stateStore,
      retryStore,
      nowUnixMilliseconds: () => nowUnixMilliseconds,
    });
    const result = await consumerWithRetry.runConsumptionStep(stepInput(partitionKey));
    expect(result.attemptedMessageCount).toBe(0);
    expect(result.blockedMessageCount).toBe(0);
    void consumer;
  });

  it("④ 持有者死亡、租约过期 ⇒ 新消费者接手处理（恢复语义）", async () => {
    const { journal, consumer, leaseStore } = buildHarness();
    await enqueue(journal, "message-1");
    await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "dead-consumer",
      ttlMilliseconds: 1000,
    });
    const whileHeld = await consumer.runConsumptionStep(stepInput(partitionKey));
    expect(whileHeld.isLeaseUnavailable).toBe(true);

    nowUnixMilliseconds += 2000;
    const afterExpiry = await consumer.runConsumptionStep(stepInput(partitionKey));
    expect(afterExpiry.isLeaseUnavailable).toBe(false);
    expect(afterExpiry.appliedMessageCount).toBe(1);
  });
});
