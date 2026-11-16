/**
 * COORD-01-02（2026-11-16，审查报告 P1 第三项）：**消费步的可调用入口**。
 *
 * 背景：`CoordinationMessageConsumer.runConsumptionStep` 在生产代码里**没有任何调用方**
 * （`git grep runConsumptionStep` 只有定义），所以"入库 → 消费 → 权威任务状态更新 →
 * ready set 重算 → 派发"这条链实际不存在。
 *
 * 2026-11-17（P1 返修）：**协调处理进度 ≠ 权威业务状态已更新**。
 * 消费器把消息标成 applied 只表示"协调器处理过了"；权威任务状态要由 `applyMessage`
 * 完成。为避免"applied 已写、业务没写、崩溃后永久漏处理"，这里改为：
 *
 * ```text
 * 每条消息：
 *   1) ledger.recordIntent   （持久化"准备更新业务状态"，先于任何业务写入）
 *   2) applyMessage          （权威状态更新，必须幂等）
 *   3) ledger.markCompleted  （或失败时 markFailed + 抛出，不吞）
 * ```
 *
 * 崩溃在 1/2 之间 ⇒ 台账仍 pending，重启补齐；在 2/3 之间 ⇒ 重放业务更新，靠幂等不重复。
 */
import type { MailboxJournal } from "../feedback-process/mailbox-journal.js";
import type {
  CoordinationConsumptionStepResult,
  CoordinationMessageConsumer,
} from "./coordination-message-consumer.js";
import type { CoordinationTaskApplicationLedger } from "./coordination-task-application-ledger.js";

export interface CoordinationConsumptionRunResult {
  readonly step: CoordinationConsumptionStepResult;
  /** 应用（含幂等重放）的消息标识；为空表示本轮没有任何可推进的任务。 */
  readonly appliedMessageIdentifiers: readonly string[];
}

export interface CoordinationConsumptionRunnerInput {
  readonly consumer: CoordinationMessageConsumer;
  readonly journal: MailboxJournal;
  readonly partitionKey: string;
  readonly recipientId: string;
  readonly ownerInstanceIdentifier: string;
  readonly leaseTtlMilliseconds: number;
  readonly maximumMessageCount?: number;
  readonly toSnapshot: (message: {
    readonly messageId: string;
    readonly payload: unknown;
  }) => Record<string, unknown>;
  /** 业务应用台账（缺省 ⇒ 不持久化意图，仅按传入顺序执行 `applyMessage`）。 */
  readonly ledger?: CoordinationTaskApplicationLedger;
  /** 台账需要定位信息（哪个 mission 的哪条消息）。 */
  readonly missionIdentifier?: string;
  /**
   * 权威状态更新（幂等）：成功返回即视为"业务已应用"。
   * 抛错 ⇒ 台账记 failed 并把错误抛出（调用方不得吞掉）。
   */
  readonly applyMessage?: (input: {
    readonly messageIdentifier: string;
    readonly missionIdentifier: string | null;
  }) => Promise<void>;
}

/** 跑一次消费步，并把应用标识逐条落到权威状态（带持久化意图）。 */
export async function runCoordinationConsumptionOnce(
  input: CoordinationConsumptionRunnerInput,
): Promise<CoordinationConsumptionRunResult> {
  const step = await input.consumer.runConsumptionStep({
    partitionKey: input.partitionKey,
    recipientId: input.recipientId,
    ownerInstanceIdentifier: input.ownerInstanceIdentifier,
    leaseTtlMilliseconds: input.leaseTtlMilliseconds,
    ...(input.maximumMessageCount === undefined
      ? {}
      : { maximumMessageCount: input.maximumMessageCount }),
    toSnapshot: input.toSnapshot,
  });

  const appliedMessageIdentifiers = step.appliedMessageIdentifiers.slice();
  for (const messageIdentifier of appliedMessageIdentifiers) {
    await applyOneCoordinationMessage({
      messageIdentifier,
      missionIdentifier: input.missionIdentifier ?? null,
      ledger: input.ledger,
      applyMessage: input.applyMessage,
    });
  }
  return { step, appliedMessageIdentifiers };
}

/**
 * 补齐台账里未完成的业务应用（启动恢复用）。
 *
 * - `pending`（意图已写、业务未做）⇒ 补做；
 * - `failed`（做过但失败）⇒ 重试；
 * - 失败不中断其余条目：逐条记录原因后继续，返回值如实报告。
 */
export async function drainCoordinationTaskApplications(input: {
  readonly ledger: CoordinationTaskApplicationLedger;
  readonly applyMessage: (input: {
    readonly messageIdentifier: string;
    readonly missionIdentifier: string | null;
  }) => Promise<void>;
}): Promise<{
  readonly attemptedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
}> {
  const recoverableEntries = await input.ledger.listRecoverable();
  let completedCount = 0;
  let failedCount = 0;
  for (const entry of recoverableEntries) {
    try {
      await input.applyMessage({
        messageIdentifier: entry.messageIdentifier,
        missionIdentifier: entry.missionIdentifier,
      });
      await input.ledger.markCompleted({ messageIdentifier: entry.messageIdentifier });
      completedCount += 1;
    } catch (error) {
      failedCount += 1;
      await input.ledger.markFailed({
        messageIdentifier: entry.messageIdentifier,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    attemptedCount: recoverableEntries.length,
    completedCount,
    failedCount,
  };
}

async function applyOneCoordinationMessage(input: {
  readonly messageIdentifier: string;
  readonly missionIdentifier: string | null;
  readonly ledger: CoordinationTaskApplicationLedger | undefined;
  readonly applyMessage:
    | ((input: {
        readonly messageIdentifier: string;
        readonly missionIdentifier: string | null;
      }) => Promise<void>)
    | undefined;
}): Promise<void> {
  if (input.ledger !== undefined && input.missionIdentifier !== null) {
    /** 1) 先持久化意图：崩溃在这一步之后、业务写入之前，重启仍能补齐。 */
    await input.ledger.recordIntent({
      messageIdentifier: input.messageIdentifier,
      missionIdentifier: input.missionIdentifier,
      taskIdentifier: null,
    });
  }
  if (input.applyMessage === undefined) {
    return;
  }
  try {
    /** 2) 权威状态更新（幂等）。 */
    await input.applyMessage({
      messageIdentifier: input.messageIdentifier,
      missionIdentifier: input.missionIdentifier,
    });
    /** 3) 结论落盘。 */
    await input.ledger?.markCompleted({ messageIdentifier: input.messageIdentifier });
  } catch (error) {
    /** 失败必须留痕并抛出：不吞异常，也不指望"再来一条新消息"恢复。 */
    await input.ledger?.markFailed({
      messageIdentifier: input.messageIdentifier,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
