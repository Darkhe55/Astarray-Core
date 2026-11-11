/**
 * COORD-01-04（卡 §7）：**故障注入**——崩溃窗口与恢复。
 *
 * 三处真实窗口：
 * - ① 状态已写入、journal 回写前崩溃 ⇒ 恢复后必须只 replay、**不得重复应用**（stateVersion 不前进）；
 * - ② 消费者死亡、租约过期 ⇒ 新消费者接管并**只应用一次**，旧 fencing token 不得提交；
 * - ③ 进程重启后同一消息再次到达 ⇒ 依旧只应用一次（幂等跨进程）。
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

let stateDirectory: string;
let partitionKey: string;
let nowUnixMilliseconds: number;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-fault-"));
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
    source: { sourceType: "agent", agentInstanceId: "worker-1" },
    recipientId: "scheduler:mission-1",
    priority: "state",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: messageId,
    payload: { kind: "success", summary: "完成" },
  } as never);
}

function stepInput() {
  return {
    partitionKey,
    recipientId: "scheduler:mission-1",
    ownerInstanceIdentifier: "consumer-a",
    leaseTtlMilliseconds: 60_000,
    toSnapshot: (message: { messageId: string }) => ({ appliedMessage: message.messageId }),
  };
}

describe("协调消费的故障注入", () => {
  it("① 状态已写、journal 未回写即崩溃 ⇒ 恢复只 replay，不重复应用", async () => {
    const { journal, leaseStore, stateStore, consumer } = buildHarness();
    await enqueue(journal, "message-1");
    await stateStore.ensurePartitionState({ partitionKey });
    const lease = (await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 60_000,
    })) as { fencingToken: number };
    /** 模拟崩溃窗口：直接写权威状态，**故意不回写 journal 的 applicationState**。 */
    const applied = await stateStore.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: lease.fencingToken,
      messageIdentifier: "message-1",
      expectedStateVersion: 0,
      nextSnapshot: { appliedMessage: "message-1" },
    });
    expect(applied.outcome).toBe("applied");

    const recovery = await consumer.runConsumptionStep(stepInput());
    expect(recovery.appliedMessageCount).toBe(0);
    expect(recovery.replayedMessageCount).toBe(1);
    const state = await stateStore.readState(partitionKey);
    expect(state?.stateVersion).toBe(1);
    expect(state?.appliedMessages).toHaveLength(1);
    const [view] = await journal.readMessageStatusView({
      recipientId: "scheduler:mission-1",
      messageId: "message-1",
    });
    expect(view?.applicationState.state).toBe("applied");
  });

  it("② 消费者死亡、租约过期 ⇒ 接管后只应用一次", async () => {
    const { journal, leaseStore, stateStore, consumer } = buildHarness();
    await enqueue(journal, "message-2");
    await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "dead-consumer",
      ttlMilliseconds: 1000,
    });
    const blocked = await consumer.runConsumptionStep(stepInput());
    expect(blocked.isLeaseUnavailable).toBe(true);

    nowUnixMilliseconds += 2000;
    const takeover = await consumer.runConsumptionStep(stepInput());
    expect(takeover.appliedMessageCount).toBe(1);
    const state = await stateStore.readState(partitionKey);
    expect(state?.appliedMessages).toHaveLength(1);
    expect(state?.pendingWakeCount).toBe(1);
  });

  it("③ 进程重启后同一消息再到达 ⇒ 依然只应用一次", async () => {
    const first = buildHarness();
    await enqueue(first.journal, "message-3");
    await first.consumer.runConsumptionStep(stepInput());

    const restarted = buildHarness();
    const replay = await restarted.consumer.runConsumptionStep(stepInput());
    expect(replay.appliedMessageCount).toBe(0);
    const state = await restarted.stateStore.readState(partitionKey);
    expect(state?.appliedMessages).toHaveLength(1);
    expect(state?.stateVersion).toBe(1);
  });
});
