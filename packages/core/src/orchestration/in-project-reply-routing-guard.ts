/**
 * 项目内回复路由守卫的**默认实现**（2026-11-14，COMM-01 裁决第 1 条 A+B）。
 *
 * 把两块已有能力接起来：
 * - **A（任务 → 派发者）**：`resolveFeedbackRecipient` 已经从任务记录里读出发布者信箱
 *   （`publishedByRecipientId`），这是"任务的原路径"的权威来源；
 * - **B（消息 → 原消息）**：邮箱在入库前能按 `replyToMessageIdentifier` 查到原消息。
 *
 * 关键决策：**任务未记录发布者时，回复一律拒绝**。
 * `resolveFeedbackRecipient` 允许"回退到默认调度信箱并如实说明"，但那对**回复**是错的——
 * 回退本质就是"按上下级/默认对象推断去向"，正是用户裁决明确否掉的做法。
 * 普通反馈可以回退，回复不行。
 */
import { DomainError } from "../core/errors.js";
import type { FeedbackMessage, TaskDependencyNode } from "../core/types.js";
import { resolveFeedbackRecipient } from "./task-publisher-feedback-route.js";
import {
  evaluateInProjectReplyRouting,
  type OriginalDeliveredMessageView,
} from "./in-project-reply-routing.js";

/** 原消息视图的最小读取面（避免把整个 JournaledMessage 类型泄漏进来）。 */
export interface DeliveredMessageLookupView {
  readonly messageId: string;
  readonly recipientId: string;
  readonly taskIdentifier?: string;
  readonly source:
    | { readonly sourceType: "agent"; readonly agentInstanceId: string }
    | { readonly sourceType: string; readonly sourceIdentifier: string };
}

function readSourceIdentifier(message: DeliveredMessageLookupView): string {
  return message.source.sourceType === "agent"
    ? (message.source as { agentInstanceId: string }).agentInstanceId
    : (message.source as { sourceIdentifier: string }).sourceIdentifier;
}

/**
 * 构造可注入 `MailboxJournal` 的守卫。
 *
 * `resolveTask` 由装配层提供（读任务链）；`defaultSchedulerRecipientId` 仅用于
 * 判断"是否发生了回退"，**不会**被当作回复去向。
 */
export function createInProjectReplyRoutingGuard(input: {
  readonly resolveTask: (input: {
    readonly missionIdentifier: string;
    readonly taskIdentifier: string;
  }) => Promise<Pick<TaskDependencyNode, "publishedByRecipientId"> | null>;
  readonly defaultSchedulerRecipientId: string;
}): (guardInput: {
  readonly message: FeedbackMessage;
  readonly findDeliveredMessage: (
    messageIdentifier: string,
  ) => Promise<DeliveredMessageLookupView | null>;
}) => Promise<void> {
  return async (guardInput) => {
    const replyToMessageIdentifier = guardInput.message.replyToMessageIdentifier ?? null;
    if (replyToMessageIdentifier === null) {
      /** 非回复消息不归本守卫管（调用方本就只在回复时调用，这里再挡一层）。 */
      return;
    }

    const taskIdentifier = guardInput.message.taskIdentifier ?? null;
    if (taskIdentifier === null) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "项目内回复缺少任务标识：拒绝按通信对象推断收件人",
      );
    }

    const missionIdentifier = guardInput.message.missionIdentifier ?? null;
    if (missionIdentifier === null || missionIdentifier.trim() === "") {
      /**
       * 任务链按 mission 存放；没有 mission 就无法定位任务链，
       * 也就无法证明"发布者是谁" ⇒ 拒绝（不猜）。
       */
      throw new DomainError(
        "task-sequence-permission-denied",
        "项目内回复缺少 mission 标识：无法定位任务链，拒绝推断收件人",
      );
    }

    const task = await input.resolveTask({ missionIdentifier, taskIdentifier });
    if (task === null) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `项目内回复找不到任务 ${taskIdentifier}：拒绝按通信对象推断收件人`,
      );
    }

    const route = resolveFeedbackRecipient({
      /** 只需发布者字段；其余字段不参与"反馈去向"判定。 */
      task: task as unknown as TaskDependencyNode,
      defaultSchedulerRecipientId: input.defaultSchedulerRecipientId,
    });
    /**
     * 回复**不接受回退**：回退意味着"任务没记发布者，就投给默认对象"，
     * 那正是被否掉的推断式路由。
     */
    const taskDispatcherIdentifier = route.fallbackReason === null ? route.recipientId : null;

    const originalMessage = await guardInput.findDeliveredMessage(replyToMessageIdentifier);
    const originalDeliveredMessage: OriginalDeliveredMessageView | null =
      originalMessage === null
        ? null
        : {
            messageIdentifier: originalMessage.messageId,
            senderIdentifier: readSourceIdentifier(originalMessage),
            recipientIdentifier: originalMessage.recipientId,
            taskIdentifier: originalMessage.taskIdentifier ?? null,
          };

    const decision = evaluateInProjectReplyRouting({
      candidate: {
        messageIdentifier: guardInput.message.messageId,
        senderIdentifier: readSourceIdentifier(
          guardInput.message as unknown as DeliveredMessageLookupView,
        ),
        recipientIdentifier: guardInput.message.recipientId,
        replyToMessageIdentifier,
        taskIdentifier,
      },
      originalDeliveredMessage,
      taskDispatcherIdentifier,
    });

    if (decision.kind === "rejected") {
      throw new DomainError(
        "task-sequence-permission-denied",
        `项目内回复被拒绝（${decision.reasonCode}）：${decision.reason}`,
      );
    }
  };
}
