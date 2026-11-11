import type { MailboxJournal } from "../feedback-process/mailbox-journal.js";
import type { CoordinationPartitionLeaseStore } from "./coordination-partition-lease.js";
import type { CoordinationStateTransactionStore } from "./coordination-state-transaction.js";

/**
 * COORD-01-02（卡 §4.2/§4.4）：协调消费步。
 *
 * 把三块接成一条链：**入库消息 → 取/续分区租约 → 短事务应用 → 回写应用状态 → 交还唤醒信号**。
 *
 * 不在这里做的事（卡内明确）：不调模型、不跑工具、不等待授权、不做长休眠。
 * 一条消息的应用失败只记 `blocked` 并继续下一条，不阻塞同分区其它消息。
 */

export interface CoordinationConsumptionStepResult {
  /** 本步尝试应用的消息数。 */
  readonly attemptedMessageCount: number;
  readonly appliedMessageCount: number;
  readonly replayedMessageCount: number;
  readonly blockedMessageCount: number;
  /** 本步结束后是否应重算 ready set（有成功应用即需要）。 */
  readonly isWakeRequested: boolean;
  /** 未取得租约（他人持有）时为 true，此时**一条都不处理**。 */
  readonly isLeaseUnavailable: boolean;
}

export interface CoordinationMessageConsumerOptions {
  readonly journal: MailboxJournal;
  readonly leaseStore: CoordinationPartitionLeaseStore;
  readonly stateStore: CoordinationStateTransactionStore;
  readonly nowUnixMilliseconds?: () => number;
}

export class CoordinationMessageConsumer {
  private readonly journal: MailboxJournal;
  private readonly leaseStore: CoordinationPartitionLeaseStore;
  private readonly stateStore: CoordinationStateTransactionStore;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: CoordinationMessageConsumerOptions) {
    this.journal = options.journal;
    this.leaseStore = options.leaseStore;
    this.stateStore = options.stateStore;
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
  }

  /**
   * 执行一步消费。
   *
   * `toSnapshot` 由调用方给出：把消息映射为权威状态快照（本地可信映射，不让模型决定状态）。
   */
  async runConsumptionStep(input: {
    partitionKey: string;
    recipientId: string;
    ownerInstanceIdentifier: string;
    leaseTtlMilliseconds: number;
    maximumMessageCount?: number;
    toSnapshot: (message: {
      messageId: string;
      payload: unknown;
    }) => Record<string, unknown>;
  }): Promise<CoordinationConsumptionStepResult> {
    await this.stateStore.ensurePartitionState({ partitionKey: input.partitionKey });

    const lease = await this.leaseStore.tryAcquire({
      partitionKey: input.partitionKey,
      ownerInstanceIdentifier: input.ownerInstanceIdentifier,
      ttlMilliseconds: input.leaseTtlMilliseconds,
    });
    if (lease.outcome === "held-by-other") {
      return {
        attemptedMessageCount: 0,
        appliedMessageCount: 0,
        replayedMessageCount: 0,
        blockedMessageCount: 0,
        isWakeRequested: false,
        isLeaseUnavailable: true,
      };
    }
    if (lease.outcome !== "acquired") {
      return {
        attemptedMessageCount: 0,
        appliedMessageCount: 0,
        replayedMessageCount: 0,
        blockedMessageCount: 0,
        isWakeRequested: false,
        isLeaseUnavailable: true,
      };
    }

    const pendingMessages = await this.journal.listPendingApplication(input.recipientId);
    const maximumMessageCount = input.maximumMessageCount ?? 32;
    const targets = pendingMessages.slice(0, maximumMessageCount);

    let appliedMessageCount = 0;
    let replayedMessageCount = 0;
    let blockedMessageCount = 0;

    for (const message of targets) {
      const currentState = await this.stateStore.readState(input.partitionKey);
      const expectedStateVersion = currentState?.stateVersion ?? 0;
      const outcome = await this.stateStore.applyMessage({
        partitionKey: input.partitionKey,
        ownerInstanceIdentifier: input.ownerInstanceIdentifier,
        fencingToken: lease.fencingToken,
        messageIdentifier: message.messageId,
        expectedStateVersion,
        nextSnapshot: input.toSnapshot({ messageId: message.messageId, payload: message.payload }),
      });

      if (outcome.outcome === "applied") {
        appliedMessageCount += 1;
        await this.journal.recordApplicationState({
          recipientId: input.recipientId,
          messageId: message.messageId,
          state: "applied",
          targetStateVersion: outcome.stateVersion,
          updatedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
        });
        continue;
      }
      if (outcome.outcome === "idempotent-replay") {
        replayedMessageCount += 1;
        await this.journal.recordApplicationState({
          recipientId: input.recipientId,
          messageId: message.messageId,
          state: "applied",
          targetStateVersion: outcome.stateVersion,
          updatedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
        });
        continue;
      }

      /** stale / not-owner / not-found：如实记 blocked，不臆造状态、不阻塞其它消息。 */
      blockedMessageCount += 1;
      await this.journal.recordApplicationState({
        recipientId: input.recipientId,
        messageId: message.messageId,
        state: "blocked",
        reason: outcome.outcome,
        targetStateVersion: expectedStateVersion,
        updatedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
      });
    }

    return {
      attemptedMessageCount: targets.length,
      appliedMessageCount,
      replayedMessageCount,
      blockedMessageCount,
      isWakeRequested: appliedMessageCount > 0 || replayedMessageCount > 0,
      isLeaseUnavailable: false,
    };
  }
}
