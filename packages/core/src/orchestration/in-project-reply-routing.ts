/**
 * 项目内回复路由判定（COMM-01 裁决第 1 条；2026-11-14）。
 *
 * 用户口径：「agent 执行任务时标记**当前任务 id**；该期间发出任务回复时**直接使用该任务 id 对应的原路径**，
 * 而不是它可能正在使用的对话或传呼其他 agent 的工具时的通信对象」。
 *
 * 跨项目通道已在 `evaluateCrossProjectDelivery` 里落过同样的规则；本文件覆盖**项目内**消息
 * （`MailboxJournal.enqueue` 那条通道），那里此前完全没有 `replyToMessageIdentifier`。
 *
 * 采用 **A + B**：
 * - **A（任务 id 绑定）**：回复必须带 `taskIdentifier`，且该任务的派发者决定收件人；
 * - **B（消息级关联）**：回复必须指向一条**已投递**的原消息，收件人必须是该消息的发起者。
 *
 * 两者缺一即拒绝——单独 A 会因 `taskIdentifier` 可选而留后门，单独 B 只证明"回的是哪条消息"。
 */
import { DomainError } from "../core/errors.js";

/** 判定所需的最小原消息视图（来源/目标对已经过基础校验）。 */
export interface OriginalDeliveredMessageView {
  readonly messageIdentifier: string;
  /** 原消息的发起者（回复的收件人必须是它）。 */
  readonly senderIdentifier: string;
  readonly recipientIdentifier: string;
  /** 原消息绑定的任务（缺省表示该消息不属于任何任务）。 */
  readonly taskIdentifier: string | null;
}

export interface InProjectReplyCandidate {
  readonly messageIdentifier: string;
  readonly senderIdentifier: string;
  readonly recipientIdentifier: string;
  /** B：回复指向的原消息。 */
  readonly replyToMessageIdentifier: string | null;
  /** A：回复发起时所在的任务。 */
  readonly taskIdentifier: string | null;
}

export type InProjectReplyRoutingDecision =
  | {
      readonly kind: "allowed";
      readonly taskIdentifier: string;
      readonly pathIdentifier: string;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "reply-without-original"
        | "reply-original-mismatch"
        | "reply-target-mismatch"
        | "reply-without-task"
        | "task-dispatcher-unknown"
        | "task-dispatcher-mismatch";
      readonly reason: string;
    };

/**
 * 判定一条项目内消息是否"沿原路径回复"。
 *
 * 判定顺序：先 B（有没有可验证的原消息）→ 再 A（任务与派发者）。
 * 顺序刻意固定：没有原消息时，"任务 id 对不对"没有意义。
 */
export function evaluateInProjectReplyRouting(input: {
  readonly candidate: InProjectReplyCandidate;
  readonly originalDeliveredMessage: OriginalDeliveredMessageView | null;
  /** A：该任务的派发者（调用方从任务链存储读出；未知传 null）。 */
  readonly taskDispatcherIdentifier: string | null;
}): InProjectReplyRoutingDecision {
  const { candidate } = input;

  if (candidate.replyToMessageIdentifier === null) {
    return {
      kind: "rejected",
      reasonCode: "reply-without-original",
      reason: "回复未指明原消息：拒绝按当前通信对象推断收件人。",
    };
  }
  const original = input.originalDeliveredMessage;
  if (original === null || original.messageIdentifier !== candidate.replyToMessageIdentifier) {
    return {
      kind: "rejected",
      reasonCode: "reply-without-original",
      reason: "找不到原消息的投递记录：不得按当前通信对象或最近会话推断收件人。",
    };
  }
  if (candidate.recipientIdentifier !== original.senderIdentifier) {
    return {
      kind: "rejected",
      reasonCode: "reply-target-mismatch",
      reason:
        "回复收件人 " +
        candidate.recipientIdentifier +
        " 不是原消息发起者 " +
        original.senderIdentifier +
        "：不得改投。",
    };
  }
  if (candidate.taskIdentifier === null) {
    return {
      kind: "rejected",
      reasonCode: "reply-without-task",
      reason: "回复未标记当前任务：无法确定原路径（不得退回通信对象）。",
    };
  }
  if (original.taskIdentifier !== null && original.taskIdentifier !== candidate.taskIdentifier) {
    return {
      kind: "rejected",
      reasonCode: "reply-original-mismatch",
      reason:
        "回复声明的任务 " +
        candidate.taskIdentifier +
        " 与原消息任务 " +
        original.taskIdentifier +
        " 不一致：跨任务回复必须走显式转交，不得直接回复。",
    };
  }
  if (input.taskDispatcherIdentifier === null) {
    return {
      kind: "rejected",
      reasonCode: "task-dispatcher-unknown",
      reason: "任务 " + candidate.taskIdentifier + " 的派发者未知：无法确认原路径。",
    };
  }
  if (input.taskDispatcherIdentifier !== candidate.recipientIdentifier) {
    return {
      kind: "rejected",
      reasonCode: "task-dispatcher-mismatch",
      reason:
        "回复收件人不是任务派发者 " +
        input.taskDispatcherIdentifier +
        "：任务回复只能回给派发者。",
    };
  }
  return {
    kind: "allowed",
    taskIdentifier: candidate.taskIdentifier,
    pathIdentifier: `${candidate.taskIdentifier}->${input.taskDispatcherIdentifier}`,
  };
}

/**
 * 入库前的强制校验（供 `MailboxJournal.enqueue` 一侧调用）。
 *
 * 为什么单独导出：邮箱是**唯一**的项目内写入点，把它做成可注入的守卫，
 * 就能保证"新入口忘记校验"不会悄悄发生。
 */
export function assertInProjectReplyRouting(
  input: Parameters<typeof evaluateInProjectReplyRouting>[0],
): void {
  const decision = evaluateInProjectReplyRouting(input);
  if (decision.kind === "rejected") {
    throw new DomainError(
      "task-sequence-permission-denied",
      `项目内回复被拒绝（${decision.reasonCode}）：${decision.reason}`,
    );
  }
}
