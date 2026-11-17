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
    /** WIRING-04-02：本次请求实际携带内容的指纹（可选，缺省不改旧行为）。 */
    readonly payloadFingerprint?: string;
  }): Promise<void>;
  /**
   * P1-3：**结果未知**。
   *
   * 请求已发起但无法确认是否送达（网络中断、超时后状态不明）时用；
   * 记 `unknown` 而不是 delivered，也不是"确定未发送"。
   */
  markUnknown(input: {
    readonly recipientId: string;
    readonly messageIdentifiers: readonly string[];
    readonly reason: string;
  }): Promise<void>;
}

/**
 * P1-3 要求 7（2026-11-17）：**按预算选择要携带的消息**。
 *
 * 之前是一轮取该个体全部 pending 消息；这既可能超出预算，也让"未进入请求"的消息
 * 无法与"已携带"区分。现在按顺序装填，**放不下的留在 pending**，不批量确认。
 *
 * 说明（如实）：当前只按**字符预算**选择。消息本身不携带任务 revision / 授权 epoch，
 * 因此"版本适用性与授权校验"没有可依据的字段——需要生产者先补字段，本函数届时再加判断。
 */
export function selectCoordinationContextEntries(input: {
  readonly entries: readonly PendingCoordinationContextEntry[];
  readonly maximumCharacterCount: number;
}): {
  readonly includedEntries: readonly PendingCoordinationContextEntry[];
  readonly excludedMessageIdentifiers: readonly string[];
} {
  const maximumCharacterCount = Math.max(0, input.maximumCharacterCount);
  const includedEntries: PendingCoordinationContextEntry[] = [];
  const excludedMessageIdentifiers: string[] = [];
  let usedCharacterCount = 0;
  for (const entry of input.entries) {
    /** 单条长度：按渲染后的实际文本计，避免"估算通过、实际超限"。 */
    const entryCharacterCount =
      entry.messageIdentifier.length +
      entry.sourceIdentifier.length +
      (entry.taskIdentifier?.length ?? 0) +
      entry.summaryText.length;
    if (usedCharacterCount + entryCharacterCount > maximumCharacterCount) {
      excludedMessageIdentifiers.push(entry.messageIdentifier);
      continue;
    }
    usedCharacterCount += entryCharacterCount;
    includedEntries.push(entry);
  }
  return { includedEntries, excludedMessageIdentifiers };
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
    async markUnknown(markInput) {
      for (const messageIdentifier of markInput.messageIdentifiers) {
        await input.journal.setContextDeliveryState({
          recipientId: markInput.recipientId,
          messageId: messageIdentifier,
          contextDeliveryState: "unknown",
        });
      }
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
          ...(markInput.payloadFingerprint === undefined
            ? {}
            : { payloadFingerprint: markInput.payloadFingerprint }),
        });
      }
    },
  };
}
