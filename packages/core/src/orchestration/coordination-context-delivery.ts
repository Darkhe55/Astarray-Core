/**
 * COORD-01-03 §5（2026-11-16 审查 P1 第二步）：**准入 → 真实请求 → 投递**。
 *
 * 第一步已经把"准入"和"投递"拆开：准入只记 `pending`，不再声称 delivered。
 * 本模块补上后半段——把**已准入但未投递**的消息内容真正放进模型请求，
 * 并在请求携带之后才把 journal 与准入回执标成 `delivered`。
 *
 * 三条纪律（对应审查报告原文）：
 * 1. 只有 `contextDeliveryState === "pending"` 且**已投递给该个体**的消息才可进入请求；
 * 2. 请求里必须带**可核对来源**：消息标识、来源个体、任务标识、正文；
 * 3. `delivered` 只表示"这次提交的请求携带了该内容"，**不表示模型理解或任务完成**。
 */
import type { MailboxJournal } from "../feedback-process/mailbox-journal.js";
import type { ContextAdmissionController } from "./context-admission.js";

export interface PendingCoordinationContextEntry {
  readonly messageIdentifier: string;
  readonly sourceIdentifier: string;
  readonly taskIdentifier: string | null;
  readonly summaryText: string;
  readonly enqueuedSequence: number;
}

export interface CoordinationContextDeliveryPort {
  collectPending(input: {
    readonly recipientId: string;
  }): Promise<readonly PendingCoordinationContextEntry[]>;
  markDelivered(input: {
    readonly recipientId: string;
    readonly messageIdentifiers: readonly string[];
    readonly requestIdentifier: string;
  }): Promise<void>;
}

/**
 * 渲染成可放进提示词的区块。
 *
 * 刻意标注"这是待处理的外部消息"而不是"背景资料"：避免模型把它当成已完成的事实。
 */
export function formatCoordinationContextBlock(
  entries: readonly PendingCoordinationContextEntry[],
): string {
  if (entries.length === 0) {
    return "";
  }
  const lines: string[] = [
    "[待处理的协调消息]",
    "以下内容来自其他个体，需要你判断如何处理；它们不是已完成的事实，也不是用户发言。",
  ];
  for (const entry of entries) {
    lines.push(
      `- 消息 ${entry.messageIdentifier}（来源 ${entry.sourceIdentifier}${
        entry.taskIdentifier === null ? "" : `，任务 ${entry.taskIdentifier}`
      }）：${entry.summaryText}`,
    );
  }
  return lines.join("\n");
}

/** 从消息载荷里取"可读正文"，只取本地已存在字段，不做模型摘要。 */
function readSummaryText(payload: unknown): string {
  if (payload === null || typeof payload !== "object") {
    return "（无可读正文）";
  }
  const record = payload as Record<string, unknown>;
  const summary = record["summary"];
  if (typeof summary === "string" && summary.trim() !== "") {
    return summary;
  }
  const questions = record["unresolvedQuestions"];
  if (Array.isArray(questions) && questions.length > 0) {
    return `未决问题：${questions.map((question) => String(question)).join("；")}`;
  }
  return "（无可读正文）";
}

/**
 * 构造端口：读邮箱取 pending 消息 → 请求携带后标 delivered。
 *
 * 注意 `markDelivered` 同时更新两处：
 * - 邮箱的 `contextDeliveryState = "delivered"`（对外状态视图）；
 * - 准入回执的 `deliveredAtIso/deliveryRequestIdentifier`（投递证据）。
 */
export function createCoordinationContextDeliveryPort(input: {
  readonly journal: MailboxJournal;
  readonly admissionController: ContextAdmissionController;
  readonly partitionKey: string;
}): CoordinationContextDeliveryPort {
  return {
    async collectPending(collectInput) {
      const document = await input.journal.loadDocument(collectInput.recipientId);
      if (document === null) {
        return [];
      }
      return document.messages
        .filter((message) => message.contextDeliveryState === "pending")
        .sort((left, right) => left.enqueuedSequence - right.enqueuedSequence)
        .map((message) => ({
          messageIdentifier: message.messageId,
          sourceIdentifier:
            message.source.sourceType === "agent"
              ? message.source.agentInstanceId
              : message.source.sourceIdentifier,
          taskIdentifier: message.taskIdentifier ?? null,
          summaryText: readSummaryText(message.payload),
          enqueuedSequence: message.enqueuedSequence,
        }));
    },
    async markDelivered(markInput) {
      for (const messageIdentifier of markInput.messageIdentifiers) {
        await input.journal.setContextDeliveryState({
          recipientId: markInput.recipientId,
          messageId: messageIdentifier,
          contextDeliveryState: "delivered",
        });
        await input.admissionController.recordDelivered({
          partitionKey: input.partitionKey,
          messageIdentifier,
          requestIdentifier: markInput.requestIdentifier,
        });
      }
    },
  };
}
