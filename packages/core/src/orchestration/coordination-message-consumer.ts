import type { MailboxJournal } from "../feedback-process/mailbox-journal.js";
import type { CoordinationPartitionLeaseStore } from "./coordination-partition-lease.js";
import type { CoordinationStateTransactionStore } from "./coordination-state-transaction.js";
import type { CoordinationRetryStore } from "./coordination-retry-store.js";
import { verifyReplyArtifactReferences } from "./reply-artifact-verification.js";

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
  /**
   * 本次**真正应用**（含 idempotent-replay）的消息标识。
   *
   * 存在的唯一理由：调用方需要据此推进**权威任务状态**与 ready set；
   * 只给出计数无法定位是哪条消息，也就无法在业务侧做可核对的状态迁移。
   */
  readonly appliedMessageIdentifiers: readonly string[];
}

export interface CoordinationMessageConsumerOptions {
  readonly journal: MailboxJournal;
  readonly leaseStore: CoordinationPartitionLeaseStore;
  readonly stateStore: CoordinationStateTransactionStore;
  /**
   * WIRING-04-01：**业务意图端口**（生产必须提供；纯函数测试可给假端口）。
   *
   * 意图先于权威状态写入；`conflict` ⇒ 该消息记 blocked 且不应用。
   */
  readonly businessIntentPort?: {
    recordIntent(input: {
      readonly messageIdentifier: string;
      readonly recipientIdentifier: string;
      readonly missionIdentifier: string | null;
      readonly projectIdentifier: string | null;
      readonly taskIdentifier: string | null;
      readonly executionAttemptIdentifier: string | null;
      readonly contentFingerprint: string;
    }): Promise<{ readonly outcome: "recorded" | "reused" | "conflict"; readonly reason?: string }>;
  };
  /** COORD-01-02 §4.7：可选失败退避（未提供则不退避，行为与之前一致）。 */
  readonly retryStore?: CoordinationRetryStore;
  /**
   * COORD-01-03 §3：**产物证明门禁**（可选）。提供时，要求产物证明的消息在应用前必须通过版本核对；
   * 不合格 ⇒ 记 `blocked` 且**不应用**。
   */
  readonly artifactGate?: {
    readonly isArtifactProofRequired: (message: {
      messageId: string;
      payload: unknown;
    }) => boolean;
    readonly resolveCurrentRevision: (artifactIdentifier: string) => Promise<number | null>;
  };
  readonly nowUnixMilliseconds?: () => number;
}

export class CoordinationMessageConsumer {
  private readonly journal: MailboxJournal;
  private readonly leaseStore: CoordinationPartitionLeaseStore;
  private readonly stateStore: CoordinationStateTransactionStore;
  private readonly retryStore: CoordinationRetryStore | undefined;
  /** WIRING-04-01：业务意图端口（先于权威状态写入）。 */
  private readonly businessIntentPort: CoordinationMessageConsumerOptions["businessIntentPort"];
  private readonly artifactGate:
    | {
        readonly isArtifactProofRequired: (message: {
          messageId: string;
          payload: unknown;
        }) => boolean;
        readonly resolveCurrentRevision: (
          artifactIdentifier: string,
        ) => Promise<number | null>;
      }
    | undefined;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: CoordinationMessageConsumerOptions) {
    this.journal = options.journal;
    this.leaseStore = options.leaseStore;
    this.stateStore = options.stateStore;
    this.retryStore = options.retryStore;
    this.businessIntentPort = options.businessIntentPort;
    this.artifactGate = options.artifactGate;
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
        appliedMessageIdentifiers: [],
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
        appliedMessageIdentifiers: [],
      };
    }

    const pendingMessages = await this.journal.listPendingApplication(input.recipientId);
    const maximumMessageCount = input.maximumMessageCount ?? 32;
    /** §4.7：退避未到期或已 blocked 的消息本轮**不尝试**（计数由 retryStore 持久化）。 */
    const eligibleMessages: typeof pendingMessages = [];
    for (const candidate of pendingMessages) {
      if (
        this.retryStore !== undefined &&
        !(await this.retryStore.isEligibleForAutomaticAttempt({
          partitionKey: input.partitionKey,
          messageIdentifier: candidate.messageId,
        }))
      ) {
        continue;
      }
      eligibleMessages.push(candidate);
    }
    const targets = eligibleMessages.slice(0, maximumMessageCount);

    let appliedMessageCount = 0;
    let replayedMessageCount = 0;
    let blockedMessageCount = 0;
    /** 本次真正应用（含幂等重放）的消息标识：供调用方推进权威任务状态。 */
    const appliedMessageIdentifiers: string[] = [];

    for (const message of targets) {
      /**
       * 2026-11-16（并发反例暴露）：**应用前再确认一次应用状态**。
       *
       * 两个实例在租约交接的瞬间都可能读到同一批 pending（读到→释放→另一个读到），
       * 仅靠租约不足以保证"同一条消息只应用一次"。这里以**已落盘的应用状态**为准，
       * 已 applied 的直接跳过，避免重复产生下游副作用。
       */
      const existingApplication = await this.journal.readMessageStatusView({
        recipientId: input.recipientId,
        messageId: message.messageId,
      });
      if (existingApplication[0]?.applicationState.state === "applied") {
        continue;
      }
      /**
       * COORD-01-03 §3：**要求产物证明的消息**先在本地核对引用版本；
       * 不合格 ⇒ 记 blocked、不应用（不靠模型自述或字段缺失放行）。
       */
      if (this.artifactGate !== undefined) {
        const isRequired = this.artifactGate.isArtifactProofRequired({
          messageId: message.messageId,
          payload: message.payload,
        });
        if (isRequired) {
          const verification = await verifyReplyArtifactReferences({
            references:
              (message.payload as { artifactReferences?: ReadonlyArray<{ artifactIdentifier: string; revision: number }> })
                .artifactReferences ?? [],
            resolveCurrentRevision: this.artifactGate.resolveCurrentRevision,
            isArtifactProofRequired: true,
          });
          if (!verification.isSatisfied) {
            blockedMessageCount += 1;
            await this.journal.recordApplicationState({
              recipientId: input.recipientId,
              messageId: message.messageId,
              state: "blocked",
              reason: verification.unsatisfiedReason,
              targetStateVersion: (await this.stateStore.readState(input.partitionKey))?.stateVersion ?? 0,
              updatedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
            });
            await this.retryStore?.recordFailure({
              partitionKey: input.partitionKey,
              messageIdentifier: message.messageId,
              reason: verification.unsatisfiedReason ?? "artifact-not-current",
            });
            continue;
          }
        }
      }
      /**
       * WIRING-04-01（2026-11-17 返修卡）：**先持久化业务意图，再动权威状态**。
       *
       * 原实现先写 journal applied、由外层 runner 事后写意图 —— 崩溃窗口里两边都不再处理。
       * 这里把意图写进循环内部，且**失败即不应用**（绝不先确认后补单）。
       */
      if (this.businessIntentPort !== undefined) {
        const contentFingerprint = JSON.stringify(message.payload);
        const intentOutcome = await this.businessIntentPort.recordIntent({
          messageIdentifier: message.messageId,
          recipientIdentifier: input.recipientId,
          missionIdentifier:
            (message as { missionIdentifier?: string }).missionIdentifier ?? null,
          projectIdentifier:
            (message as { projectIdentifier?: string }).projectIdentifier ?? null,
          taskIdentifier: message.taskIdentifier ?? null,
          executionAttemptIdentifier: null,
          contentFingerprint,
        });
        if (intentOutcome.outcome === "conflict") {
          blockedMessageCount += 1;
          await this.journal.recordApplicationState({
            recipientId: input.recipientId,
            messageId: message.messageId,
            state: "blocked",
            reason: intentOutcome.reason ?? "业务意图冲突",
            targetStateVersion: null,
            updatedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
          });
          continue;
        }
      }
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
        appliedMessageIdentifiers.push(message.messageId);
        await this.retryStore?.recordSuccess({
          partitionKey: input.partitionKey,
          messageIdentifier: message.messageId,
        });
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
        /**
         * **幂等重放不计入 `appliedMessageIdentifiers`**：
         * 那一列用于触发下游权威状态更新，重放再触发一次会造成重复副作用。
         */
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
      /** §4.7：失败计入持久退避；达上限后转 blocked，只有显式重试才重启。 */
      await this.retryStore?.recordFailure({
        partitionKey: input.partitionKey,
        messageIdentifier: message.messageId,
        reason: outcome.outcome,
      });
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
      appliedMessageIdentifiers,
    };
  }
}
