/**
 * COORD 检查点 2 收尾（2026-11-16）：**重复投递 / 并发消费 / 重复唤醒 不得重复产生副作用**。
 *
 * 说明（如实记录验证范围）：
 * - 这里的"两个进程"用**两个独立实例共享同一磁盘目录**表示。COORD 的租约是**文件级**持久租约
 *   （`CoordinationPartitionLeaseStore`），不存在实例内 Set 的问题；因此两个实例走的是与两个进程
 *   完全相同的读写路径。
 * - 仍未做的是真正 `spawn` 子进程的用例（需要构建产物），见卡内断点。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { CoordinationMessageConsumer } from "../../../packages/core/src/orchestration/coordination-message-consumer.js";
import { CoordinationPartitionLeaseStore } from "../../../packages/core/src/orchestration/coordination-partition-lease.js";
import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";
import { runCoordinationConsumptionOnce } from "../../../packages/core/src/orchestration/coordination-consumption-runner.js";
import { applyCoordinationMessageToTaskState } from "../../../packages/core/src/orchestration/coordination-task-state.js";

let stateDirectory: string;
const PARTITION_KEY = "project-alpha|scheduler-1";
const RECIPIENT_ID = "scheduler:mission-1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord-race-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildProcessInstance() {
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
  return { journal, consumer };
}

async function enqueue(journal: MailboxJournal, messageId: string) {
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

function buildRun(
  instance: ReturnType<typeof buildProcessInstance>,
  /** 逐条应用（2026-11-17 起由 runner 按消息调用）。 */
  onApplyMessage?: (messageIdentifier: string) => Promise<void>,
  ownerInstanceIdentifier = "scheduler-1",
) {
  return {
    consumer: instance.consumer,
    journal: instance.journal,
    partitionKey: PARTITION_KEY,
    recipientId: RECIPIENT_ID,
    ownerInstanceIdentifier,
    leaseTtlMilliseconds: 60_000,
    toSnapshot: (message: { messageId: string }) => ({ lastAppliedMessageId: message.messageId }),
    ...(onApplyMessage === undefined
      ? {}
      : {
          applyMessage: async ({ messageIdentifier }: { messageIdentifier: string }) =>
            onApplyMessage(messageIdentifier),
        }),
  } as never;
}

describe("消费的副作用不重复", () => {
  it("① 重复投递同一条消息 ⇒ 第二次不应用、不再触发下游", async () => {
    const instance = buildProcessInstance();
    await enqueue(instance.journal, "message-1");

    const firstApplied: string[][] = [];
    await runCoordinationConsumptionOnce(
      buildRun(instance, async (messageIdentifier: string) => {
        firstApplied.push([messageIdentifier]);
      }) as never,
    );

    const secondApplied: string[][] = [];
    await runCoordinationConsumptionOnce(
      buildRun(instance, async (messageIdentifier: string) => {
        secondApplied.push([messageIdentifier]);
      }) as never,
    );

    expect(firstApplied).toEqual([["message-1"]]);
    /** 第二次是幂等重放：计数可涨，但**不得再次触发权威状态更新**。 */
    expect(secondApplied).toEqual([]);
  });

  it("② 两个实例并发消费同一分区 ⇒ 只有一个应用，另一个拿不到租约", async () => {
    const first = buildProcessInstance();
    const second = buildProcessInstance();
    await enqueue(first.journal, "message-1");

    const appliedByFirst: string[][] = [];
    const appliedBySecond: string[][] = [];
    const [firstResult, secondResult] = await Promise.all([
      runCoordinationConsumptionOnce(
        buildRun(first, async (messageIdentifier: string) => {
          appliedByFirst.push([messageIdentifier]);
        }) as never,
      ),
      runCoordinationConsumptionOnce(
        buildRun(
          second,
          async (messageIdentifier: string) => {
            appliedBySecond.push([messageIdentifier]);
          },
          "process-b",
        ) as never,
      ),
    ]);

    /** 关键：无论谁先跑，**总共只应用一次**（并发时另一个拿不到租约，顺序时另一个无待应用消息）。 */
    const totalApplied =
      firstResult.appliedMessageIdentifiers.length + secondResult.appliedMessageIdentifiers.length;
    expect(totalApplied).toBe(1);
    expect(appliedByFirst.length + appliedBySecond.length).toBe(1);
  });

  it("③ 重复唤醒 ⇒ 权威任务链只发生一次状态迁移（下游不重复副作用）", async () => {
    const instance = buildProcessInstance();
    await enqueue(instance.journal, "message-1");

    /** 记录"真正写盘"的次数：第二次若已是目标状态必须是 status-unchanged（不写盘）。 */
    let writeCount = 0;
    const chainTasks = [
      {
        id: "T-001",
        description: "执行",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
        status: "running",
        assignedAgentId: "worker-1",
        resultLocation: null,
      },
    ] as never[];
    /** 假任务链必须**保存写入结果**，否则第二次读还是 running，会误判为需要再迁移。 */
    let currentChain: Record<string, unknown> = {
      schemaVersion: 1,
      missionId: "mission-1",
      revision: 1,
      updatedAtIso: "2026-11-16T00:00:00.000Z",
      tasks: chainTasks,
    };
    const taskStore = {
      readTaskChain: async () => currentChain,
      updateTaskChain: async (_missionId: string, updater: (c: unknown) => unknown) => {
        writeCount += 1;
        currentChain = updater(currentChain) as Record<string, unknown>;
        return currentChain;
      },
    };

    const runOnce = () =>
      runCoordinationConsumptionOnce(
        buildRun(instance, async (messageIdentifier: string) => {
          const message = await instance.journal.findMessageByIdentifier(
            RECIPIENT_ID,
            messageIdentifier,
          );
          if (message === null) return;
          await applyCoordinationMessageToTaskState({
            taskStore: taskStore as never,
            missionIdentifiers: ["mission-1"],
            message: {
              messageIdentifier,
              taskIdentifier: message.taskIdentifier ?? null,
              payload: message.payload,
            },
            /** WIRING-04-03：完成凭证（本用例验证并发语义）。 */
            completionAuthorization: {
              code: "authoritative-completion-accepted",
              decidedAtIso: "2026-11-17T00:00:00.000Z",
            },
          });
        }) as never,
      );

    await Promise.all([runOnce(), runOnce()]);
    await runOnce();

    expect(writeCount).toBe(1);
  });
});
