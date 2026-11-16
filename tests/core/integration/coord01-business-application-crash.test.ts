/**
 * P1-1（2026-11-17）：**"消息已 applied，但权威任务状态未更新"的崩溃窗口**。
 *
 * 反例直接构造崩溃点，不靠 sleep：
 * - 意图已写、业务未做 ⇒ 重启补齐；
 * - 业务已做、回执未写 ⇒ 重启重放，**不得重复产生副作用**；
 * - 业务抛错 ⇒ 台账留 failed + 原因，重启可重试；
 * - 两个消费者竞争 ⇒ 只有一个业务更新。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { CoordinationMessageConsumer } from "../../../packages/core/src/orchestration/coordination-message-consumer.js";
import { CoordinationPartitionLeaseStore } from "../../../packages/core/src/orchestration/coordination-partition-lease.js";
import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";
import {
  drainCoordinationTaskApplications,
  runCoordinationConsumptionOnce,
} from "../../../packages/core/src/orchestration/coordination-consumption-runner.js";
import { CoordinationTaskApplicationLedger } from "../../../packages/core/src/orchestration/coordination-task-application-ledger.js";
import { applyCoordinationMessageToTaskState } from "../../../packages/core/src/orchestration/coordination-task-state.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";

let baseDirectory: string;
const RECIPIENT_ID = "scheduler:mission-1";
const PARTITION_KEY = "project-alpha|scheduler-1";
const MISSION_IDENTIFIER = "mission-1";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord-crash-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildJournal(): MailboxJournal {
  return new MailboxJournal(baseDirectory);
}

function buildConsumer(journal: MailboxJournal, owner: string) {
  const leaseStore = new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(baseDirectory, "leases"),
    nowUnixMilliseconds: () => 1_700_000_000_000,
  });
  const stateStore = new CoordinationStateTransactionStore({
    stateDirectory: path.join(baseDirectory, "state"),
    leaseStore,
    nowUnixMilliseconds: () => 1_700_000_000_000,
  });
  const consumer = new CoordinationMessageConsumer({
    journal,
    leaseStore,
    stateStore,
  });
  return { consumer, leaseStore, stateStore, owner };
}

async function enqueueSuccessMessage(journal: MailboxJournal, messageId: string) {
  await journal.enqueue({
    protocolVersion: 1,
    messageId,
    source: { sourceType: "agent", agentInstanceId: "worker-1" },
    recipientId: RECIPIENT_ID,
    priority: "state",
    createdAtIso: "2026-11-17T00:00:00.000Z",
    idempotencyKey: messageId,
    taskIdentifier: "T-001",
    payload: { kind: "success", summary: "完成" },
  } as never);
}

/** 有状态假任务链：写入次数可数，状态可读（模拟权威任务链）。 */
function buildTaskStore() {
  let revision = 1;
  let status: string = "running";
  let writeCount = 0;
  const chain = (): TaskChainDocument =>
    ({
      schemaVersion: 1,
      missionId: MISSION_IDENTIFIER,
      revision,
      updatedAtIso: "2026-11-17T00:00:00.000Z",
      tasks: [
        {
          id: "T-001",
          description: "执行",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
          status,
          assignedAgentId: "worker-1",
          resultLocation: null,
        },
      ],
    }) as never;
  return {
    readTaskChain: async () => chain(),
    updateTaskChain: async (
      _missionIdentifier: string,
      updater: (current: TaskChainDocument | null) => TaskChainDocument,
    ) => {
      const next = updater(chain());
      revision = next.revision;
      status = String(next.tasks[0]?.status ?? status);
      writeCount += 1;
      return next;
    },
    getStatus: () => status,
    getWriteCount: () => writeCount,
  };
}

function buildApply(taskStore: ReturnType<typeof buildTaskStore>, journal: MailboxJournal) {
  return async (input: {
    messageIdentifier: string;
    missionIdentifier: string | null;
  }): Promise<void> => {
    const message = await journal.findMessageByIdentifier(RECIPIENT_ID, input.messageIdentifier);
    if (message === null) {
      throw new Error(`消息不在邮箱里: ${input.messageIdentifier}`);
    }
    await applyCoordinationMessageToTaskState({
      taskStore: taskStore as never,
      missionIdentifiers: [input.missionIdentifier ?? MISSION_IDENTIFIER],
      message: {
        messageIdentifier: input.messageIdentifier,
        taskIdentifier: message.taskIdentifier ?? null,
        payload: message.payload,
      },
    });
  };
}

describe("P1-1 业务应用崩溃窗口", () => {
  it("① 意图已写、业务未做 ⇒ 重启后补齐（任务变 done，台账 completed）", async () => {
    const journal = buildJournal();
    await enqueueSuccessMessage(journal, "message-1");
    const ledger = new CoordinationTaskApplicationLedger({ baseDirectory });
    const taskStore = buildTaskStore();

    /** 模拟"消费完成 + 意图已写 ⇒ 崩溃"（业务更新没发生）。 */
    await ledger.recordIntent({
      messageIdentifier: "message-1",
      missionIdentifier: MISSION_IDENTIFIER,
      taskIdentifier: "T-001",
    });
    expect(taskStore.getStatus()).toBe("running");

    const drained = await drainCoordinationTaskApplications({
      ledger,
      applyMessage: buildApply(taskStore, journal),
    });

    expect(drained).toMatchObject({ attemptedCount: 1, completedCount: 1, failedCount: 0 });
    expect(taskStore.getStatus()).toBe("done");
    expect((await ledger.readAll()).get("message-1")?.status).toBe("completed");
  });

  it("② 业务已做、回执未写 ⇒ 重启重放不重复产生副作用（只一次状态迁移）", async () => {
    const journal = buildJournal();
    await enqueueSuccessMessage(journal, "message-1");
    const ledger = new CoordinationTaskApplicationLedger({ baseDirectory });
    const taskStore = buildTaskStore();

    await ledger.recordIntent({
      messageIdentifier: "message-1",
      missionIdentifier: MISSION_IDENTIFIER,
      taskIdentifier: "T-001",
    });
    /** 只做业务更新，不写回执（模拟崩溃点 2/3 之间）。 */
    await buildApply(taskStore, journal)({
      messageIdentifier: "message-1",
      missionIdentifier: MISSION_IDENTIFIER,
    });
    expect(taskStore.getWriteCount()).toBe(1);

    await drainCoordinationTaskApplications({
      ledger,
      applyMessage: buildApply(taskStore, journal),
    });

    /** 幂等：已是 done ⇒ 不再写盘（写次数保持 1），也不得再次释放/派发。 */
    expect(taskStore.getWriteCount()).toBe(1);
    expect(taskStore.getStatus()).toBe("done");
    expect((await ledger.readAll()).get("message-1")?.status).toBe("completed");
  });

  it("③ 业务更新抛错 ⇒ 台账 failed 且保留原因；重试成功后才 completed", async () => {
    const journal = buildJournal();
    await enqueueSuccessMessage(journal, "message-1");
    const ledger = new CoordinationTaskApplicationLedger({ baseDirectory });
    const taskStore = buildTaskStore();

    const firstAttempt = await drainFailingOnce({
      ledger,
      taskStore,
      journal,
      messageIdentifier: "message-1",
    });
    expect(firstAttempt).toBe("failed");
    const failedEntry = (await ledger.readAll()).get("message-1");
    expect(failedEntry?.status).toBe("failed");
    expect(failedEntry?.reason).toContain("注入失败");

    const secondAttempt = await drainCoordinationTaskApplications({
      ledger,
      applyMessage: buildApply(taskStore, journal),
    });
    expect(secondAttempt.completedCount).toBe(1);
    expect((await ledger.readAll()).get("message-1")?.status).toBe("completed");
  });

  it("④ 两个消费者竞争同一分区 ⇒ 只有一个业务更新（不重复写）", async () => {
    const journal = buildJournal();
    await enqueueSuccessMessage(journal, "message-1");
    const ledger = new CoordinationTaskApplicationLedger({ baseDirectory });
    const taskStore = buildTaskStore();

    const first = buildConsumer(journal, "process-a");
    const second = buildConsumer(journal, "process-b");
    const apply = buildApply(taskStore, journal);

    const runOnce = (consumer: CoordinationMessageConsumer, owner: string) =>
      runCoordinationConsumptionOnce({
        consumer,
        journal,
        partitionKey: PARTITION_KEY,
        recipientId: RECIPIENT_ID,
        ownerInstanceIdentifier: owner,
        leaseTtlMilliseconds: 60_000,
        toSnapshot: (message) => ({ lastAppliedMessageId: message.messageId }),
        ledger,
        missionIdentifier: MISSION_IDENTIFIER,
        applyMessage: apply,
      });

    await Promise.all([runOnce(first.consumer, "process-a"), runOnce(second.consumer, "process-b")]);

    expect(taskStore.getStatus()).toBe("done");
    expect(taskStore.getWriteCount()).toBe(1);
    expect((await ledger.readAll()).get("message-1")?.status).toBe("completed");
  });
});

/** 让首次业务更新失败（保留台账状态），用于反例 ③。 */
async function drainFailingOnce(input: {
  ledger: CoordinationTaskApplicationLedger;
  taskStore: ReturnType<typeof buildTaskStore>;
  journal: MailboxJournal;
  messageIdentifier: string;
}): Promise<"failed" | "completed"> {
  await input.ledger.recordIntent({
    messageIdentifier: input.messageIdentifier,
    missionIdentifier: MISSION_IDENTIFIER,
    taskIdentifier: "T-001",
  });
  const result = await drainCoordinationTaskApplications({
    ledger: input.ledger,
    applyMessage: async () => {
      throw new Error("注入失败：权威状态更新不可用");
    },
  });
  return result.failedCount > 0 ? "failed" : "completed";
}
