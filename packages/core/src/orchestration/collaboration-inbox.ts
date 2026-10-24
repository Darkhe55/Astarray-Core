/**
 * COMM-01-02 §2.4（2026-10-24）：**协作收件箱**。
 *
 * 卡内原文：
 * - "接收、投递、已处理、业务完成为不同状态；重复投递复用回执，不重复插入任务。
 *    每收件人背压、有限重试、转发跳数和关联链循环检测复用现有机制。"
 * - "关系变更与授权撤销后，在途旧消息不得落入新任务或新个体。"
 *
 * 本模块是纯内存状态机（不读写磁盘、不调模型、不发网络）：
 * 上层负责持久化与投递，这里只保证**状态语义与背压/重试/撤销的判定**。
 */
import {
  evaluateCollaborationRelayChain,
  type CollaborationRelayChain,
} from "./collaboration-relay-chain.js";

/** 收件箱状态（四态分离 + 失败终态）。 */
export const COLLABORATION_INBOX_STATES = [
  "received",
  "delivered",
  "processed",
  "completed",
  "failed",
] as const;
export type CollaborationInboxState = (typeof COLLABORATION_INBOX_STATES)[number];

/** 单条收件箱消息。 */
export interface CollaborationInboxMessage {
  readonly messageIdentifier: string;
  readonly correlationIdentifier: string;
  readonly recipientAgentInstanceId: string;
  readonly senderAgentInstanceId: string;
  readonly taskIdentifier: string;
  readonly summary: string;
  readonly receivedAtIso: string;
  /** 入箱时的授权代（授权撤销/关系变更后旧代消息不得投递）。 */
  readonly authorizationEpoch: number;
  state: CollaborationInboxState;
  deliveryAttemptCount: number;
  lastFailureAtIso: string | null;
  deliveredAtIso: string | null;
  processedAtIso: string | null;
  completedAtIso: string | null;
  /** 重复投递次数（复用回执，不重复插入任务）。 */
  duplicateDeliveryCount: number;
}

/** 回执（重复投递复用同一份）。 */
export interface CollaborationInboxReceipt {
  readonly messageIdentifier: string;
  readonly correlationIdentifier: string;
  readonly recipientAgentInstanceId: string;
  readonly state: CollaborationInboxState;
  readonly isDuplicate: boolean;
}

export type CollaborationInboxEnqueueOutcome =
  | "accepted"
  | "duplicate"
  | "rejected-backpressure"
  | "rejected-relay-chain"
  | "rejected-invalid";

export interface CollaborationInboxEnqueueResult {
  readonly outcome: CollaborationInboxEnqueueOutcome;
  /** 是否重复投递（复用回执）。 */
  readonly isDuplicate: boolean;
  readonly message: CollaborationInboxMessage | null;
  readonly receipt: CollaborationInboxReceipt | null;
  readonly reason: string;
}

export interface CollaborationInboxOptions {
  /** 每收件人待处理（received + delivered）上限。 */
  readonly maximumPendingPerRecipient: number;
  /** 投递失败重试上限（达到即转 failed，不再无限重试）。 */
  readonly maximumDeliveryAttempts: number;
  /** 首次退避秒数（指数退避，上限 3 小时 = 10800 秒，与卡内 pn 上限一致）。 */
  readonly baseRetryBackoffSeconds?: number;
}

const MAXIMUM_RETRY_BACKOFF_SECONDS = 3 * 60 * 60;

function isPending(state: CollaborationInboxState): boolean {
  return state === "received" || state === "delivered";
}

export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationInboxMessage>();
  private readonly maximumPendingPerRecipient: number;
  private readonly maximumDeliveryAttempts: number;
  private readonly baseRetryBackoffSeconds: number;

  constructor(options: CollaborationInboxOptions) {
    this.maximumPendingPerRecipient = Math.max(1, options.maximumPendingPerRecipient);
    this.maximumDeliveryAttempts = Math.max(1, options.maximumDeliveryAttempts);
    this.baseRetryBackoffSeconds = Math.max(1, options.baseRetryBackoffSeconds ?? 30);
  }

  /**
   * 入箱。
   *
   * 判定顺序：参数合法 → 重复投递（复用回执）→ 转达链（跳数/环）→ 每收件人背压。
   */
  enqueue(input: {
    readonly messageIdentifier: string;
    readonly correlationIdentifier: string;
    readonly recipientAgentInstanceId: string;
    readonly senderAgentInstanceId: string;
    readonly taskIdentifier: string;
    readonly summary: string;
    readonly receivedAtIso: string;
    readonly authorizationEpoch?: number;
    readonly relayChain?: CollaborationRelayChain;
  }): CollaborationInboxEnqueueResult {
    for (const field of [
      input.messageIdentifier,
      input.correlationIdentifier,
      input.recipientAgentInstanceId,
      input.senderAgentInstanceId,
      input.taskIdentifier,
    ]) {
      if (field.trim() === "") {
        return {
          outcome: "rejected-invalid",
          isDuplicate: false,
          message: null,
          receipt: null,
          reason: "消息缺少必填标识（message/correlation/recipient/sender/task）。",
        };
      }
    }

    const existing = this.messages.get(input.messageIdentifier);
    if (existing !== undefined) {
      existing.duplicateDeliveryCount += 1;
      return {
        outcome: "duplicate",
        isDuplicate: true,
        message: existing,
        receipt: {
          messageIdentifier: existing.messageIdentifier,
          correlationIdentifier: existing.correlationIdentifier,
          recipientAgentInstanceId: existing.recipientAgentInstanceId,
          state: existing.state,
          isDuplicate: true,
        },
        reason: "重复投递：复用既有回执，不重复插入任务。",
      };
    }

    const relayChainVerdict = evaluateCollaborationRelayChain({
      originalSourceAgentInstanceId: input.senderAgentInstanceId,
      targetAgentInstanceId: input.recipientAgentInstanceId,
      ...(input.relayChain === undefined ? {} : { relayChain: input.relayChain }),
    });
    if (!relayChainVerdict.isAllowed) {
      return {
        outcome: "rejected-relay-chain",
        isDuplicate: false,
        message: null,
        receipt: null,
        reason: relayChainVerdict.reason,
      };
    }

    const pendingCount = this.listForRecipient(input.recipientAgentInstanceId).filter((item) =>
      isPending(item.state),
    ).length;
    if (pendingCount >= this.maximumPendingPerRecipient) {
      return {
        outcome: "rejected-backpressure",
        isDuplicate: false,
        message: null,
        receipt: null,
        reason:
          "收件人 `" +
          input.recipientAgentInstanceId +
          "` 背压已满（待处理 " +
          String(pendingCount) +
          " / 上限 " +
          String(this.maximumPendingPerRecipient) +
          "）：请稍后重试，不静默丢弃。",
      };
    }

    const message: CollaborationInboxMessage = {
      messageIdentifier: input.messageIdentifier,
      correlationIdentifier: input.correlationIdentifier,
      recipientAgentInstanceId: input.recipientAgentInstanceId,
      senderAgentInstanceId: input.senderAgentInstanceId,
      taskIdentifier: input.taskIdentifier,
      summary: input.summary,
      receivedAtIso: input.receivedAtIso,
      authorizationEpoch: input.authorizationEpoch ?? 0,
      state: "received",
      deliveryAttemptCount: 0,
      lastFailureAtIso: null,
      deliveredAtIso: null,
      processedAtIso: null,
      completedAtIso: null,
      duplicateDeliveryCount: 0,
    };
    this.messages.set(message.messageIdentifier, message);
    return {
      outcome: "accepted",
      isDuplicate: false,
      message,
      receipt: {
        messageIdentifier: message.messageIdentifier,
        correlationIdentifier: message.correlationIdentifier,
        recipientAgentInstanceId: message.recipientAgentInstanceId,
        state: message.state,
        isDuplicate: false,
      },
      reason: "已接收（received ≠ delivered）。",
    };
  }

  /**
   * 标记投递。
   *
   * 传 `currentAuthorizationEpoch` 时，与入箱代不一致 ⇒ 拒绝投递：
   * 关系变更/授权撤销后，在途旧消息**不得落入新任务**。
   */
  markDelivered(
    messageIdentifier: string,
    deliveredAtIso: string,
    options: { readonly currentAuthorizationEpoch?: number } = {},
  ): { readonly isDelivered: boolean; readonly reason: string } {
    const message = this.messages.get(messageIdentifier);
    if (message === undefined) return { isDelivered: false, reason: "消息不存在。" };
    if (message.state !== "received") {
      return {
        isDelivered: false,
        reason: "只有 received 可投递（当前 " + message.state + "）。",
      };
    }
    if (
      options.currentAuthorizationEpoch !== undefined &&
      options.currentAuthorizationEpoch !== message.authorizationEpoch
    ) {
      return {
        isDelivered: false,
        reason:
          "授权已变更（入箱代 " +
          String(message.authorizationEpoch) +
          "，当前代 " +
          String(options.currentAuthorizationEpoch) +
          "）：在途旧消息不得落入新任务。",
      };
    }
    message.state = "delivered";
    message.deliveredAtIso = deliveredAtIso;
    return { isDelivered: true, reason: "已投递（投递 ≠ 已处理 ≠ 业务完成）。" };
  }

  /** 标记已处理：必须先投递。 */
  markProcessed(
    messageIdentifier: string,
    processedAtIso: string,
  ): { readonly isProcessed: boolean; readonly reason: string } {
    const message = this.messages.get(messageIdentifier);
    if (message === undefined) return { isProcessed: false, reason: "消息不存在。" };
    if (message.state !== "delivered") {
      return {
        isProcessed: false,
        reason: "必须先投递（delivered）才可标记已处理（当前 " + message.state + "）。",
      };
    }
    message.state = "processed";
    message.processedAtIso = processedAtIso;
    return { isProcessed: true, reason: "已处理（业务结果仍未完成）。" };
  }

  /** 标记业务完成：必须先已处理。 */
  markCompleted(
    messageIdentifier: string,
    completedAtIso: string,
  ): { readonly isCompleted: boolean; readonly reason: string } {
    const message = this.messages.get(messageIdentifier);
    if (message === undefined) return { isCompleted: false, reason: "消息不存在。" };
    if (message.state !== "processed") {
      return {
        isCompleted: false,
        reason: "只有 processed 可标记业务完成（当前 " + message.state + "）。",
      };
    }
    message.state = "completed";
    message.completedAtIso = completedAtIso;
    return { isCompleted: true, reason: "业务完成。" };
  }

  /**
   * 记录一次投递失败：指数退避；达到上限转 `failed` 并停止重试。
   */
  recordDeliveryFailure(
    messageIdentifier: string,
    failedAtIso: string,
  ): {
    readonly deliveryAttemptCount: number;
    readonly isExhausted: boolean;
    readonly retryAfterSeconds: number | null;
    readonly reason: string;
  } {
    const message = this.messages.get(messageIdentifier);
    if (message === undefined) {
      return {
        deliveryAttemptCount: 0,
        isExhausted: true,
        retryAfterSeconds: null,
        reason: "消息不存在。",
      };
    }
    message.deliveryAttemptCount += 1;
    message.lastFailureAtIso = failedAtIso;
    if (message.deliveryAttemptCount >= this.maximumDeliveryAttempts) {
      message.state = "failed";
      return {
        deliveryAttemptCount: message.deliveryAttemptCount,
        isExhausted: true,
        retryAfterSeconds: null,
        reason:
          "已达重试上限（" +
          String(this.maximumDeliveryAttempts) +
          " 次）：转 failed，停止重试（不无限重试）。",
      };
    }
    const backoffSeconds =
      this.baseRetryBackoffSeconds * 2 ** (message.deliveryAttemptCount - 1);
    return {
      deliveryAttemptCount: message.deliveryAttemptCount,
      isExhausted: false,
      retryAfterSeconds: Math.min(MAXIMUM_RETRY_BACKOFF_SECONDS, backoffSeconds),
      reason: "投递失败：有限重试（退避后重试）。",
    };
  }

  /**
   * 从持久化快照恢复（重启后状态不丢）。
   *
   * 只接受已校验的条目；调用方负责先通过 `CollaborationInboxStore.read` 的 schema 校验。
   */
  static fromSnapshot(input: {
    readonly messages: ReadonlyArray<CollaborationInboxMessage>;
    readonly maximumPendingPerRecipient: number;
    readonly maximumDeliveryAttempts: number;
    readonly baseRetryBackoffSeconds?: number;
  }): CollaborationInbox {
    const inbox = new CollaborationInbox({
      maximumPendingPerRecipient: input.maximumPendingPerRecipient,
      maximumDeliveryAttempts: input.maximumDeliveryAttempts,
      ...(input.baseRetryBackoffSeconds === undefined
        ? {}
        : { baseRetryBackoffSeconds: input.baseRetryBackoffSeconds }),
    });
    for (const message of input.messages) {
      inbox.messages.set(message.messageIdentifier, { ...message });
    }
    return inbox;
  }

  /** 导出快照（交给持久化层）。 */
  toSnapshot(): ReadonlyArray<CollaborationInboxMessage> {
    return [...this.messages.values()].map((message) => ({ ...message }));
  }
  getMessage(messageIdentifier: string): CollaborationInboxMessage | null {
    return this.messages.get(messageIdentifier) ?? null;
  }

  listForRecipient(recipientAgentInstanceId: string): ReadonlyArray<CollaborationInboxMessage> {
    return [...this.messages.values()].filter(
      (message) => message.recipientAgentInstanceId === recipientAgentInstanceId,
    );
  }
}



