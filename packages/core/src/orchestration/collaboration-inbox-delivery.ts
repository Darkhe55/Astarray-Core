/**
 * COMM-01-02（2026-10-24）：**收件箱投递通道**。
 *
 * 把持久化收件箱接到可注入的传输端口上：
 * - 成功 ⇒ 标记 `delivered` 并落盘；
 * - 失败 ⇒ 有限重试（指数退避），达到上限转 `failed`，**不再发送**；
 * - 授权代已变 ⇒ 不投递（在途旧消息不落新任务）；
 * - 不持锁等待传输：只在发送前后读写，发送期间不占用持久化锁；
 * - revision 冲突 ⇒ 报告冲突并**放弃本次落盘**（不覆盖他人更新）。
 */
import {
  CollaborationInbox,
  type CollaborationInboxMessage,
} from "./collaboration-inbox.js";
import {
  CollaborationInboxRevisionConflictError,
  type CollaborationInboxStore,
} from "./collaboration-inbox-store.js";

/** 传输端口：由上层实现（IPC/进程间/测试桩）。 */
export interface CollaborationInboxTransportPort {
  send(message: CollaborationInboxMessage): Promise<{
    readonly isDelivered: boolean;
    readonly reason?: string;
  }>;
}

export interface CollaborationInboxDeliveryReport {
  readonly outcome:
    | "no-inbox"
    | "nothing-pending"
    | "delivered"
    | "partially-delivered"
    | "revision-conflict"
    | "failed"
    | "invalid-inbox";
  readonly deliveredCount: number;
  readonly retriedCount: number;
  readonly exhaustedCount: number;
  readonly skippedStaleCount: number;
  readonly reason: string;
}

export interface CollaborationInboxDeliveryOptions {
  readonly maximumPendingPerRecipient: number;
  readonly maximumDeliveryAttempts: number;
  readonly baseRetryBackoffSeconds?: number;
}

export class CollaborationInboxDeliveryService {
  private readonly store: CollaborationInboxStore;
  private readonly transport: CollaborationInboxTransportPort;
  private readonly options: CollaborationInboxDeliveryOptions;

  constructor(input: {
    readonly store: CollaborationInboxStore;
    readonly transport: CollaborationInboxTransportPort;
    readonly options: CollaborationInboxDeliveryOptions;
  }) {
    this.store = input.store;
    this.transport = input.transport;
    this.options = input.options;
  }

  /**
   * 投递某收件人的所有 pending 消息。
   *
   * 顺序：读取 → 逐条发送（不持锁）→ 按结果更新内存状态 → 一次性落盘。
   */
  async deliverPendingForRecipient(input: {
    readonly recipientAgentInstanceId: string;
    readonly nowIso: string;
    /** 当前授权代：与消息入箱代不同 ⇒ 跳过（不落新任务）。 */
    readonly currentAuthorizationEpoch?: number;
  }): Promise<CollaborationInboxDeliveryReport> {
    const readOutcome = await this.store.read(input.recipientAgentInstanceId);
    if (readOutcome.kind === "absent") {
      return {
        outcome: "no-inbox",
        deliveredCount: 0,
        retriedCount: 0,
        exhaustedCount: 0,
        skippedStaleCount: 0,
        reason: "收件箱不存在（空 ≠ 无消息）。",
      };
    }
    if (readOutcome.kind === "invalid") {
      return {
        outcome: "invalid-inbox",
        deliveredCount: 0,
        retriedCount: 0,
        exhaustedCount: 0,
        skippedStaleCount: 0,
        reason: "收件箱不可读：" + readOutcome.reason,
      };
    }

    const inbox = CollaborationInbox.fromSnapshot({
      messages: readOutcome.snapshot.messages,
      maximumPendingPerRecipient: this.options.maximumPendingPerRecipient,
      maximumDeliveryAttempts: this.options.maximumDeliveryAttempts,
      ...(this.options.baseRetryBackoffSeconds === undefined
        ? {}
        : { baseRetryBackoffSeconds: this.options.baseRetryBackoffSeconds }),
    });

    const pending = readOutcome.snapshot.messages.filter((message) => message.state === "received");
    if (pending.length === 0) {
      return {
        outcome: "nothing-pending",
        deliveredCount: 0,
        retriedCount: 0,
        exhaustedCount: 0,
        skippedStaleCount: 0,
        reason: "没有待投递消息（投递 ≠ 已处理 ≠ 业务完成）。",
      };
    }

    let deliveredCount = 0;
    let retriedCount = 0;
    let exhaustedCount = 0;
    let skippedStaleCount = 0;

    for (const message of pending) {
      if (
        input.currentAuthorizationEpoch !== undefined &&
        input.currentAuthorizationEpoch !== message.authorizationEpoch
      ) {
        skippedStaleCount += 1;
        continue;
      }
      const result = await this.transport.send(message);
      if (result.isDelivered) {
        inbox.markDelivered(message.messageIdentifier, input.nowIso);
        deliveredCount += 1;
        continue;
      }
      const failure = inbox.recordDeliveryFailure(message.messageIdentifier, input.nowIso);
      if (failure.isExhausted) exhaustedCount += 1;
      else retriedCount += 1;
    }

    try {
      await this.store.save(input.recipientAgentInstanceId, {
        messages: inbox.toSnapshot(),
        expectedRevision: readOutcome.snapshot.revision,
        updatedAtIso: input.nowIso,
      });
    } catch (error) {
      if (error instanceof CollaborationInboxRevisionConflictError) {
        return {
          outcome: "revision-conflict",
          deliveredCount: 0,
          retriedCount: 0,
          exhaustedCount: 0,
          skippedStaleCount,
          reason:
            "落盘时发现 revision 冲突（可能被其他写入者更新）：本次投递结果未提交，请重试。",
        };
      }
      throw error;
    }

    const outcome =
      deliveredCount === pending.length
        ? "delivered"
        : deliveredCount > 0
          ? "partially-delivered"
          : "delivered";
    return {
      outcome,
      deliveredCount,
      retriedCount,
      exhaustedCount,
      skippedStaleCount,
      reason:
        "投递完成：成功 " +
        String(deliveredCount) +
        " / 待重试 " +
        String(retriedCount) +
        " / 已耗尽 " +
        String(exhaustedCount) +
        " / 跳过陈旧 " +
        String(skippedStaleCount) +
        "。",
    };
  }
}


