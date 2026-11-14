/**
 * 持久化 mailbox journal（T04）。
 * 每个接收者一个 journal 文件；投递成功并收到 ack 后才从未投递集合消费。
 * 写入使用原子替换；损坏时走备份恢复，绝不静默覆盖。
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import {
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import type { FeedbackMessage } from "../core/types.js";
import { MESSAGE_PRIORITY_ORDER } from "../core/types.js";

export interface JournaledMessage extends FeedbackMessage {
  /** 入池序号：同优先级 FIFO 的依据。 */
  enqueuedSequence: number;
  delivered: boolean;
  deliveredAtIso: string | null;
  /**
   * COORD-01-02：**应用**状态（与投递状态分开记录）。
   * 卡内要求"可靠收到不等于应用成功"，禁止用一个布尔同时代表两者。
   */
  applicationState?: MailboxApplicationStateRecord;
  /** COORD-01-02：上下文注入状态（delivered 只代表已携带，不代表模型已理解）。 */
  contextDeliveryState?: MailboxContextDeliveryStateName;
}

/** 应用状态取值（卡内冻结的五个）。 */
export type MailboxApplicationStateName =
  | "pending"
  | "applied"
  | "ignored-stale"
  | "blocked"
  | "rejected";

/** 上下文注入状态取值（卡内冻结的四个）。 */
export type MailboxContextDeliveryStateName =
  | "not-required"
  | "pending"
  | "delivered"
  | "unknown";

export interface MailboxApplicationStateRecord {
  state: MailboxApplicationStateName;
  reason: string | null;
  /** 本次应用针对的目标状态版本（用于识别陈旧消息）。 */
  targetStateVersion: number | null;
  attemptCount: number;
  updatedAtIso: string;
}

export interface MailboxJournalDocument {
  schemaVersion: 1;
  recipientId: string;
  nextSequence: number;
  messages: JournaledMessage[];
}

export const MAILBOX_JOURNAL_SCHEMA_VERSION = 1;

/**
 * COORD-01-02 修正：收件人 ID 可能含 `:`（协作前缀 `agent:<id>`），而 Windows 文件名不允许冒号。
 * 这里做**可逆编码**：只转义非法字符，普通 ID 文件名保持不变（对既有 journal 向后兼容）。
 */
function encodeRecipientFileName(recipientId: string): string {
  return recipientId.replace(/[^A-Za-z0-9._-]/gu, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return `%${codePoint.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

function decodeRecipientFileName(fileName: string): string {
  return fileName.replace(/%([0-9A-F]{2})/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function priorityRank(priority: FeedbackMessage["priority"]): number {
  return MESSAGE_PRIORITY_ORDER.indexOf(priority);
}

/**
 * COORD-01-02（卡 §3）：消息的**三状态只读视图**。
 *
 * 卡内明确禁止"用一个 consumed 布尔同时代表三种状态"——因此这里固定输出三个独立字段，
 * 并且 `applicationState` 缺省为 `pending`（尚未应用），而不是与 delivered 混为一谈。
 */
export interface MailboxMessageStatusView {
  readonly messageIdentifier: string;
  readonly deliveryState: {
    readonly isDelivered: boolean;
    readonly deliveredAtIso: string | null;
  };
  readonly applicationState: {
    readonly state: MailboxApplicationStateName;
    readonly reason: string | null;
    readonly targetStateVersion: number | null;
    readonly attemptCount: number;
  };
  readonly contextDeliveryState: MailboxContextDeliveryStateName;
}

export class MailboxJournal {
  /**
   * 读改写串行化（2026-10-22）：`enqueue / markDelivered / ack` 都是「读文档 → 改 → 原子写回」，
   * 并发时后者会用旧快照覆盖前者（实测：并发入池 3 条只落盘 1 条、ack 后消息复活）。
   * 这里按实例串行化，保证同一进程内的并发调用不丢更新。
   */
  private operationQueue: Promise<void> = Promise.resolve();

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private readonly journalDirectoryPath: string;
  /**
   * COMM-01（2026-11-14）：**项目内回复路由守卫**（可选注入）。
   *
   * 邮箱是项目内唯一的消息写入点，因此把守卫挂在这里，避免"某个新入口忘了校验"。
   * 未注入时，带 `replyToMessageIdentifier` 的消息一律拒绝（fail-closed），
   * 而不是"没人管就放行"。
   */
  private readonly replyRoutingGuard:
    | ((input: {
        readonly message: FeedbackMessage;
        readonly findDeliveredMessage: (
          messageIdentifier: string,
        ) => Promise<JournaledMessage | null>;
      }) => Promise<void>)
    | undefined;

  constructor(
    baseDirectory: string,
    options: {
      readonly replyRoutingGuard?: (input: {
        readonly message: FeedbackMessage;
        readonly findDeliveredMessage: (
          messageIdentifier: string,
        ) => Promise<JournaledMessage | null>;
      }) => Promise<void>;
    } = {},
  ) {
    this.journalDirectoryPath = path.join(baseDirectory, "feedback", "mailboxes");
    this.replyRoutingGuard = options.replyRoutingGuard;
  }

  private journalFilePath(recipientId: string): string {
    return path.join(this.journalDirectoryPath, `${encodeRecipientFileName(recipientId)}.json`);
  }

  private backupFilePath(recipientId: string): string {
    return path.join(
      this.journalDirectoryPath,
      `${recipientId}.json.bak`,
    );
  }

  async loadDocument(
    recipientId: string,
  ): Promise<MailboxJournalDocument | null> {
    const readResult = await readJsonWithBackupRecovery(
      this.journalFilePath(recipientId),
      this.backupFilePath(recipientId),
    );
    if (readResult === null) {
      return null;
    }
    const parsed = parseJournalDocument(readResult.content);
    if (parsed === null) {
      throw new DomainError(
        "journal-corrupted",
        `mailbox journal 内容非法: ${recipientId}`,
      );
    }
    return parsed;
  }

  async enqueue(message: FeedbackMessage): Promise<number> {
    return this.runExclusive(() => this.enqueueExclusive(message));
  }

  /**
   * ALIGN-03-06（2026-10-28）：**幂等入库**。
   *
   * 同一 `idempotencyKey` 重放（补送/重连重发）**不会再追加一条**：
   * - 内容一致 ⇒ 返回既有条目的序列号（不重复投递）；
   * - 内容不一致 ⇒ `operation-not-idempotent`（拒绝覆盖，也不静默丢弃）。
   *
   * "内容"比较刻意排除 `messageId` 与 `createdAtIso`：重发可能带新 id/时间戳，
   * 只比较来源、目标、优先级与 payload —— 那才是"同一条消息"的实质。
   */
  private async enqueueExclusive(message: FeedbackMessage): Promise<number> {
    /**
     * COMM-01（2026-11-14）：**回复必须先过路由守卫**（fail-closed）。
     *
     * 顺序刻意在幂等判断之前：即便同幂等键已入库，也不能让一条"路径不合规"的回复
     * 因为去重而被当成已受理。
     */
    if (message.replyToMessageIdentifier !== undefined) {
      if (this.replyRoutingGuard === undefined) {
        throw new DomainError(
          "task-sequence-permission-denied",
          "项目内回复需要回复路由守卫：未装配时拒绝按通信对象推断收件人",
        );
      }
      /**
       * 原消息落在**回复方自己的邮箱**里（它当初是收件人）；
       * 因此按回复方的身份推导邮箱键：agent 取实例标识，其它来源取 sourceIdentifier。
       */
      const replierMailboxIdentifier =
        message.source.sourceType === "agent"
          ? message.source.agentInstanceId
          : message.source.sourceIdentifier;
      await this.replyRoutingGuard({
        message,
        findDeliveredMessage: async (messageIdentifier: string) =>
          await this.findMessageByIdentifier(replierMailboxIdentifier, messageIdentifier),
      });
    }
    const recipientId = message.recipientId;
    const document = (await this.loadDocument(recipientId)) ?? {
      schemaVersion: MAILBOX_JOURNAL_SCHEMA_VERSION,
      recipientId,
      nextSequence: 1,
      messages: [],
    };
    const existingMessage = document.messages.find(
      (candidate) => candidate.idempotencyKey === message.idempotencyKey,
    );
    if (existingMessage !== undefined) {
      if (
        JSON.stringify(existingMessage.source) !== JSON.stringify(message.source) ||
        existingMessage.recipientId !== message.recipientId ||
        existingMessage.priority !== message.priority ||
        /** COORD-01-02：归属键不同也算"同键异内容"，不得静默复用。 */
        existingMessage.projectIdentifier !== message.projectIdentifier ||
        existingMessage.taskIdentifier !== message.taskIdentifier ||
        JSON.stringify(existingMessage.payload) !== JSON.stringify(message.payload)
      ) {
        throw new DomainError(
          "operation-not-idempotent",
          `同幂等键异内容，拒绝入库: ${message.idempotencyKey}`,
        );
      }
      return existingMessage.enqueuedSequence;
    }
    const journaledMessage: JournaledMessage = {
      ...message,
      enqueuedSequence: document.nextSequence,
      delivered: false,
      deliveredAtIso: null,
    };
    document.messages.push(journaledMessage);
    document.nextSequence += 1;
    await this.saveDocument(document);
    return journaledMessage.enqueuedSequence;
  }

  /**
   * 下一条待投递/待重放消息：
   * 1) 已投递未确认（重放优先，保证重启后 ack 前崩溃的消息先恢复）；
   * 2) 从未投递的消息。
   * 各自内部按（优先级, 入池序号）排序：优先级高者在前，同优先级 FIFO。
   */
  /**
   * COMM-01：按消息标识查一条**已入库**消息（用于回复路由校验）。
   *
   * 只看指定收件人的文档：一条消息只会落在它自己的收件人邮箱里，
   * 跨收件人扫描既慢又会把"别人的消息"当成原消息。
   */
  async findMessageByIdentifier(
    recipientId: string,
    messageIdentifier: string,
  ): Promise<JournaledMessage | null> {
    if (recipientId.trim() === "" || messageIdentifier.trim() === "") {
      return null;
    }
    const document = await this.loadDocument(recipientId);
    if (document === null) {
      return null;
    }
    return document.messages.find((message) => message.messageId === messageIdentifier) ?? null;
  }

  async peekNext(recipientId: string): Promise<JournaledMessage | null> {
    const document = await this.loadDocument(recipientId);
    if (document === null) {
      return null;
    }
    const undeliveredMessages = document.messages
      .filter((message) => !message.delivered)
      .sort(compareByPriorityThenSequence);
    const unackedMessages = document.messages
      .filter((message) => message.delivered)
      .sort(compareByPriorityThenSequence);
    return unackedMessages[0] ?? undeliveredMessages[0] ?? null;
  }

  async markDelivered(
    recipientId: string,
    messageId: string,
    deliveredAtIso: string,
  ): Promise<void> {
    return this.runExclusive(() =>
      this.markDeliveredExclusive(recipientId, messageId, deliveredAtIso),
    );
  }

  private async markDeliveredExclusive(
    recipientId: string,
    messageId: string,
    deliveredAtIso: string,
  ): Promise<void> {
    await this.mutateRecipient(recipientId, (message) => {
      message.delivered = true;
      message.deliveredAtIso = deliveredAtIso;
    }, messageId);
  }

  async ack(recipientId: string, messageId: string): Promise<void> {
    return this.runExclusive(() => this.ackExclusive(recipientId, messageId));
  }

  private async ackExclusive(recipientId: string, messageId: string): Promise<void> {
    const document = (await this.loadDocument(recipientId)) ?? null;
    if (document === null) {
      return;
    }
    const remainingMessages = document.messages.filter(
      (message) => message.messageId !== messageId,
    );
    if (remainingMessages.length === document.messages.length) {
      return;
    }
    document.messages = remainingMessages;
    await this.saveDocument(document);
  }

  /**
   * COORD-01-02：记录消息的**应用**结果（与"已投递"分开）。
   *
   * - 幂等：同 `messageId` 同目标版本重复上报 ⇒ 不重复计数，返回 `idempotent-replay`；
   * - 陈旧：目标版本低于已记录的目标版本 ⇒ 记 `ignored-stale`，**不改动**既有结论；
   * - 冲突：同目标版本但结论不同 ⇒ 以新结论为准并计一次尝试（冲突由上层上报 `rejected`）。
   */
  async recordApplicationState(input: {
    recipientId: string;
    messageId: string;
    state: MailboxApplicationStateName;
    reason?: string | null;
    targetStateVersion?: number | null;
    updatedAtIso: string;
  }): Promise<{
    outcome: "applied" | "idempotent-replay" | "ignored-stale" | "not-found";
  }> {
    return this.runExclusive(async () => {
      const document = await this.loadDocument(input.recipientId);
      if (document === null) return { outcome: "not-found" as const };
      const message = document.messages.find(
        (candidate) => candidate.messageId === input.messageId,
      );
      if (message === undefined) return { outcome: "not-found" as const };

      const nextTargetStateVersion = input.targetStateVersion ?? null;
      const existing = message.applicationState;
      if (existing !== undefined && existing.targetStateVersion === nextTargetStateVersion) {
        if (existing.state === input.state) {
          /** 同版本同结论：重复上报，不重复计数。 */
          return { outcome: "idempotent-replay" as const };
        }
      }
      if (
        existing !== undefined &&
        existing.targetStateVersion !== null &&
        nextTargetStateVersion !== null &&
        nextTargetStateVersion < existing.targetStateVersion
      ) {
        /** 陈旧：不覆盖已应用结论，但如实记录"曾有陈旧上报"。 */
        existing.attemptCount += 1;
        existing.updatedAtIso = input.updatedAtIso;
        existing.reason = input.reason ?? existing.reason;
        await this.saveDocument(document);
        return { outcome: "ignored-stale" as const };
      }

      message.applicationState = {
        state: input.state,
        reason: input.reason ?? null,
        targetStateVersion: nextTargetStateVersion,
        attemptCount: (existing?.attemptCount ?? 0) + 1,
        updatedAtIso: input.updatedAtIso,
      };
      await this.saveDocument(document);
      return { outcome: "applied" as const };
    });
  }

  /**
   * COORD-01-02：列出该收件人**尚未被应用**的消息（按入池序号升序）。
   * 供协调器按序应用；已 applied 的消息不再返回，避免重复处理。
   */
  async listPendingApplication(recipientId: string): Promise<JournaledMessage[]> {
    const document = await this.loadDocument(recipientId);
    if (document === null) return [];
    return document.messages
      .filter((message) => message.applicationState?.state !== "applied")
      .sort((left, right) => left.enqueuedSequence - right.enqueuedSequence);
  }

  /**
   * 只读查询：返回该收件人（或指定消息）的三状态。
   * 未知收件人/消息 ⇒ 空数组（**不伪造** pending 记录）。
   */
  async readMessageStatusView(input: {
    recipientId: string;
    messageId?: string;
  }): Promise<MailboxMessageStatusView[]> {
    const document = await this.loadDocument(input.recipientId);
    if (document === null) return [];
    const matched = document.messages.filter(
      (message) => input.messageId === undefined || message.messageId === input.messageId,
    );
    return matched.map((message) => ({
      messageIdentifier: message.messageId,
      deliveryState: {
        isDelivered: message.delivered,
        deliveredAtIso: message.deliveredAtIso,
      },
      applicationState: {
        state: message.applicationState?.state ?? "pending",
        reason: message.applicationState?.reason ?? null,
        targetStateVersion: message.applicationState?.targetStateVersion ?? null,
        attemptCount: message.applicationState?.attemptCount ?? 0,
      },
      contextDeliveryState: message.contextDeliveryState ?? "not-required",
    }));
  }

  /** COORD-01-03 §5：上下文注入状态写入点（与 applicationState 分开）。 */
  async setContextDeliveryState(input: {
    recipientId: string;
    messageId: string;
    contextDeliveryState: MailboxContextDeliveryStateName;
  }): Promise<void> {
    const document = await this.loadDocument(input.recipientId);
    if (document === null) return;
    const message = document.messages.find((candidate) => candidate.messageId === input.messageId);
    if (message === undefined) return;
    message.contextDeliveryState = input.contextDeliveryState;
    await this.saveDocument(document);
  }

  async countPending(recipientId: string): Promise<number> {
    const document = await this.loadDocument(recipientId);
    if (document === null) {
      return 0;
    }
    return document.messages.length;
  }

  async listRecipientIds(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.journalDirectoryPath);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.endsWith(".json") && !entry.endsWith(".json.bak"))
      .map((entry) => decodeRecipientFileName(entry.slice(0, -".json".length)));
  }

  private async mutateRecipient(
    recipientId: string,
    mutation: (message: JournaledMessage) => void,
    messageId: string,
  ): Promise<void> {
    const document = await this.loadDocument(recipientId);
    if (document === null) {
      return;
    }
    const targetMessage = document.messages.find(
      (message) => message.messageId === messageId,
    );
    if (targetMessage === undefined) {
      return;
    }
    mutation(targetMessage);
    await this.saveDocument(document);
  }

  private async saveDocument(document: MailboxJournalDocument): Promise<void> {
    const filePath = this.journalFilePath(document.recipientId);
    await writeAtomicJson(filePath, document);
  }
}

function compareByPriorityThenSequence(
  left: JournaledMessage,
  right: JournaledMessage,
): number {
  const priorityDifference =
    priorityRank(left.priority) - priorityRank(right.priority);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  return left.enqueuedSequence - right.enqueuedSequence;
}

function parseJournalDocument(content: unknown): MailboxJournalDocument | null {
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const candidate = content as Partial<MailboxJournalDocument>;
  if (
    candidate.schemaVersion !== MAILBOX_JOURNAL_SCHEMA_VERSION ||
    typeof candidate.recipientId !== "string" ||
    typeof candidate.nextSequence !== "number" ||
    !Array.isArray(candidate.messages)
  ) {
    return null;
  }
  const isValidMessageList = candidate.messages.every(isValidJournaledMessage);
  if (!isValidMessageList) {
    return null;
  }
  return {
    schemaVersion: MAILBOX_JOURNAL_SCHEMA_VERSION,
    recipientId: candidate.recipientId,
    nextSequence: candidate.nextSequence,
    messages: candidate.messages,
  };
}

function isValidJournaledMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<JournaledMessage>;
  return (
    typeof candidate.messageId === "string" &&
    typeof candidate.recipientId === "string" &&
    typeof candidate.enqueuedSequence === "number" &&
    typeof candidate.delivered === "boolean" &&
    (candidate.deliveredAtIso === null ||
      typeof candidate.deliveredAtIso === "string")
  );
}
