/**
 * COORD 消费入口（2026-11-16，审查报告 P1 第三项）。
 *
 * 目的：证明"调一次消费步"是可运行的，并且**把应用了哪些消息**交给调用方，
 * 而不是只更新协调器内部状态就当作任务状态已更新。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { CoordinationMessageConsumer } from "../../../packages/core/src/orchestration/coordination-message-consumer.js";
import { CoordinationPartitionLeaseStore } from "../../../packages/core/src/orchestration/coordination-partition-lease.js";
import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";
import { runCoordinationConsumptionOnce } from "../../../packages/core/src/orchestration/coordination-consumption-runner.js";

let stateDirectory: string;
const PARTITION_KEY = "project-alpha|scheduler-1";
const RECIPIENT_ID = "scheduler:mission-1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord-runner-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildConsumer() {
  const journal = new MailboxJournal(stateDirectory);
  const leaseStore = new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(stateDirectory, "leases"),
    nowUnixMilliseconds: () => 1_700_000_000_000,
  });
  const stateStore = new CoordinationStateTransactionStore({
    stateDirectory: path.join(stateDirectory, "state"),
    leaseStore,
    nowUnixMilliseconds: () => 1_700_000_000_000,
  });
  const consumer = new CoordinationMessageConsumer({ journal, leaseStore, stateStore });
  return { consumer, journal };
}

async function enqueueMessage(journal: MailboxJournal, messageId: string) {
  await journal.enqueue({
    protocolVersion: 1,
    messageId,
    source: { sourceType: "agent", agentInstanceId: "worker-1" },
    recipientId: RECIPIENT_ID,
    priority: "state",
    createdAtIso: "2026-11-16T00:00:00.000Z",
    idempotencyKey: messageId,
    taskIdentifier: "T-001",
    payload: { kind: "success", summary: "完成" },
  } as never);
}

function buildRunInput(input: {
  consumer: CoordinationMessageConsumer;
  journal: MailboxJournal;
  onAppliedMessages?: (applied: {
    appliedMessageIdentifiers: readonly string[];
    step: { isWakeRequested: boolean };
  }) => Promise<void>;
}) {
  return {
    consumer: input.consumer,
    journal: input.journal,
    partitionKey: PARTITION_KEY,
    recipientId: RECIPIENT_ID,
    ownerInstanceIdentifier: "scheduler-1",
    leaseTtlMilliseconds: 60_000,
    toSnapshot: (message: { messageId: string }) => ({ lastAppliedMessageId: message.messageId }),
    ...(input.onAppliedMessages === undefined
      ? {}
      : { onAppliedMessages: input.onAppliedMessages }),
  };
}

describe("消费入口", () => {
  it("① 无待应用消息 ⇒ 不应用、不调用钩子", async () => {
    const { consumer, journal } = buildConsumer();
    const onAppliedMessages = vi.fn(async () => undefined);
    const result = await runCoordinationConsumptionOnce(
      buildRunInput({ consumer, journal, onAppliedMessages }) as never,
    );
    expect(result.appliedMessageIdentifiers).toEqual([]);
    expect(onAppliedMessages).not.toHaveBeenCalled();
  });

  it("② 有待应用消息 ⇒ 应用并把消息标识交给调用方（不是只给计数）", async () => {
    const { consumer, journal } = buildConsumer();
    await enqueueMessage(journal, "message-1");
    const received: Array<readonly string[]> = [];
    const result = await runCoordinationConsumptionOnce(
      buildRunInput({
        consumer,
        journal,
        onAppliedMessages: async ({ appliedMessageIdentifiers }) => {
          received.push(appliedMessageIdentifiers);
        },
      }) as never,
    );

    expect(result.appliedMessageIdentifiers).toEqual(["message-1"]);
    expect(received).toEqual([["message-1"]]);
    expect(result.step.isWakeRequested).toBe(true);
  });

  it("③ 租约被他人持有 ⇒ 一条都不应用，钩子不调用", async () => {
    const { consumer, journal } = buildConsumer();
    await enqueueMessage(journal, "message-1");

    /**
     * 直接由"另一个进程"占住租约：消费步只在**执行期间**持锁，
     * 结束后立即释放（长模型调用/工具执行不得占用租约），
     * 所以这里必须显式抢占，不能靠"跑完一次消费步"来模拟。
     */
    const otherProcessLeaseStore = new CoordinationPartitionLeaseStore({
      stateDirectory: path.join(stateDirectory, "leases"),
      nowUnixMilliseconds: () => 1_700_000_000_000,
    });
    const heldLease = await otherProcessLeaseStore.tryAcquire({
      partitionKey: PARTITION_KEY,
      ownerInstanceIdentifier: "process-b",
      ttlMilliseconds: 60_000,
    });
    expect(heldLease.outcome).toBe("acquired");

    const onAppliedMessages = vi.fn(async () => undefined);
    const result = await runCoordinationConsumptionOnce(
      buildRunInput({ consumer, journal, onAppliedMessages }) as never,
    );
    expect(result.step.isLeaseUnavailable).toBe(true);
    expect(result.appliedMessageIdentifiers).toEqual([]);
    expect(onAppliedMessages).not.toHaveBeenCalled();
  });

  it("④ 调用方钩子抛错 ⇒ 向上抛出（不静默吞掉“状态没推进”）", async () => {
    const { consumer, journal } = buildConsumer();
    await enqueueMessage(journal, "message-1");
    await expect(
      runCoordinationConsumptionOnce(
        buildRunInput({
          consumer,
          journal,
          onAppliedMessages: async () => {
            throw new Error("权威状态更新失败");
          },
        }) as never,
      ),
    ).rejects.toThrow(/权威状态更新失败/u);
  });
});
