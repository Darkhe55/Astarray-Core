/**
 * COORD-01-02（2026-11-16，审查报告 P1 第三项）：**消费步的可调用入口**。
 *
 * 背景：`CoordinationMessageConsumer.runConsumptionStep` 在生产代码里**没有任何调用方**
 * （`git grep runConsumptionStep` 只有定义），所以"入库 → 消费 → 权威任务状态更新 →
 * ready set 重算 → 派发"这条链实际不存在。
 *
 * 本模块把"调一次消费步"封装成可复用入口，并强制把**应用了哪些消息**交给调用方，
 * 避免"只更新协调器内部状态就当作任务状态已更新"——那是审查报告明确点名的假接线。
 *
 * 调用方（尚未接线，见卡内断点）必须提供 `onAppliedMessages`：
 * 它负责把消息映射到**权威任务状态**（任务链）并触发 ready set 重算与派发；
 * 本模块不自行改任务状态，也不持有第二套任务真相。
 */
import type { MailboxJournal } from "../feedback-process/mailbox-journal.js";
import type {
  CoordinationConsumptionStepResult,
  CoordinationMessageConsumer,
} from "./coordination-message-consumer.js";

export interface CoordinationConsumptionRunResult {
  readonly step: CoordinationConsumptionStepResult;
  /** 应用（含幂等重放）的消息标识；为空表示本轮没有任何可推进的任务。 */
  readonly appliedMessageIdentifiers: readonly string[];
}

/**
 * 跑一次消费步。
 *
 * - 未取得租约 / 无待应用消息 ⇒ 返回空结果，**不调用** `onAppliedMessages`；
 * - 有应用 ⇒ 先完成消费（含幂等与状态迁移），再把标识交给调用方推进权威状态；
 * - 调用方钩子抛错 ⇒ 向上抛出：宁可让本轮失败被看见，也不静默吞掉"状态没推进"。
 */
export async function runCoordinationConsumptionOnce(input: {
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
  readonly onAppliedMessages?: (applied: {
    readonly appliedMessageIdentifiers: readonly string[];
    readonly step: CoordinationConsumptionStepResult;
  }) => Promise<void>;
}): Promise<CoordinationConsumptionRunResult> {
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
  if (appliedMessageIdentifiers.length > 0 && input.onAppliedMessages !== undefined) {
    await input.onAppliedMessages({ appliedMessageIdentifiers, step });
  }
  return { step, appliedMessageIdentifiers };
}
