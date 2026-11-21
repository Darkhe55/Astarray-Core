/**
 * COORD-02 / 用户裁决 A（2026-11-21）：**协作收件箱的只读读取出口**。
 *
 * 背景：协作请求过去只能经投递链路"推"进上下文，没有统一的"读"入口；
 * 用户要求它跟随**任务列表的统一读取出口**（`taskSequenceStatus`）一起读出来。
 *
 * 本模块只做**纯读取**，三条铁律：
 * 1. **读取 ≠ 投递 ≠ 确认**：不改消息状态、不记交付失败、不推进四态机；
 * 2. **身份隔离**：只返回 `recipientAgentInstanceId === 请求者` 的消息（harness 注入身份，模型不能自报）；
 * 3. **授权过滤**：读取时按权威授权存储**只读复核**当前代际；未通过的消息不出现在结果里，
 *    只如实计入 `skippedUnauthorizedCount`（不静默、也不投递）。
 *
 * 分页：按 `receivedAtIso + messageIdentifier` 稳定排序，`nextCursor` 为上一页最后一条的键；
 * 传入旧游标时只返回键更大的条目（新增消息可能落在游标之前 ⇒ 下一轮重新读即可）。
 */
import type {
  CollaborationInboxMessage,
  CollaborationInboxState,
} from "./collaboration-inbox.js";
import type { CollaborationInboxReadOutcome } from "./collaboration-inbox-store.js";
import type { CrossProjectAuthorizationStore } from "./cross-project-authorization-store.js";
import { evaluateAuthoritativeAuthorization } from "./collaboration-authoritative-delivery.js";

export const COLLABORATION_INBOX_READ_DEFAULT_PAGE_SIZE = 10;
export const COLLABORATION_INBOX_READ_MAXIMUM_PAGE_SIZE = 50;

/** 单条只读摘要：只含标识/归属/摘要，**不含正文**。 */
export interface CollaborationInboxReadItem {
  readonly messageIdentifier: string;
  readonly correlationIdentifier: string;
  readonly senderAgentInstanceId: string;
  readonly originalSourceAgentInstanceId: string;
  readonly isRelayedRequest: boolean;
  readonly taskIdentifier: string;
  readonly missionIdentifier: string | null;
  readonly replyToMessageIdentifier: string | null;
  readonly summary: string;
  readonly receivedAtIso: string;
  readonly state: CollaborationInboxState;
  readonly artifactReferenceStatus: "provided" | "not-provided";
  readonly authorizationEpoch: number;
}

export interface PendingCollaborationView {
  readonly isAvailable: true;
  readonly items: readonly CollaborationInboxReadItem[];
  /** 通过授权的待处理（`received`）消息总数（分页前）。 */
  readonly totalPendingCount: number;
  /** 因授权复核未通过而未返回的条数（如实计数，不静默）。 */
  readonly skippedUnauthorizedCount: number;
  readonly nextCursor: string | null;
  readonly isTruncated: boolean;
  /** 给模型看的只读提示。 */
  readonly readOnlyNotice: string;
}

export interface PendingCollaborationUnavailable {
  readonly isAvailable: false;
  readonly reason: string;
}

export type PendingCollaborationReadOutcome =
  | PendingCollaborationView
  | PendingCollaborationUnavailable;

export interface CollaborationInboxReadPort {
  readPendingCollaboration(input: {
    readonly requestingAgentInstanceId: string;
    readonly pageSize?: number;
    readonly cursor?: string | null;
  }): Promise<PendingCollaborationReadOutcome>;
}

function cursorKeyOf(message: CollaborationInboxMessage): string {
  return `${message.receivedAtIso}|${message.messageIdentifier}`;
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) {
    return COLLABORATION_INBOX_READ_DEFAULT_PAGE_SIZE;
  }
  const floored = Math.floor(pageSize);
  if (floored < 1) {
    return 1;
  }
  return Math.min(COLLABORATION_INBOX_READ_MAXIMUM_PAGE_SIZE, floored);
}

function comparePending(left: CollaborationInboxMessage, right: CollaborationInboxMessage): number {
  const byTime = Date.parse(left.receivedAtIso) - Date.parse(right.receivedAtIso);
  if (byTime !== 0) {
    return byTime;
  }
  return left.messageIdentifier.localeCompare(right.messageIdentifier);
}

function projectItem(message: CollaborationInboxMessage): CollaborationInboxReadItem {
  return {
    messageIdentifier: message.messageIdentifier,
    correlationIdentifier: message.correlationIdentifier,
    senderAgentInstanceId: message.senderAgentInstanceId,
    originalSourceAgentInstanceId: message.originalSourceAgentInstanceId,
    isRelayedRequest: message.isRelayedRequest,
    taskIdentifier: message.taskIdentifier,
    missionIdentifier: message.missionIdentifier ?? null,
    replyToMessageIdentifier: message.replyToMessageIdentifier ?? null,
    summary: message.summary,
    receivedAtIso: message.receivedAtIso,
    state: message.state,
    artifactReferenceStatus: message.artifactReferenceStatus,
    authorizationEpoch: message.authorizationEpoch,
  };
}

/**
 * 纯函数：按身份、状态、授权集合与游标构造只读视图（不做 I/O）。
 */
export function buildPendingCollaborationView(input: {
  readonly messages: readonly CollaborationInboxMessage[];
  readonly requestingAgentInstanceId: string;
  readonly authorizedMessageIdentifiers: ReadonlySet<string>;
  readonly pageSize?: number;
  readonly cursor?: string | null;
}): PendingCollaborationView {
  const pageSize = normalizePageSize(input.pageSize);
  const cursor = input.cursor ?? null;

  const pending = input.messages
    /** 只读"待处理"（received）；delivered/processed/completed/failed 不是新请求。 */
    .filter((message) => message.state === "received")
    .filter(
      (message) => message.recipientAgentInstanceId === input.requestingAgentInstanceId,
    )
    .sort(comparePending);

  const authorized = pending.filter((message) =>
    input.authorizedMessageIdentifiers.has(message.messageIdentifier),
  );
  const skippedUnauthorizedCount = pending.length - authorized.length;

  const afterCursor =
    cursor === null ? authorized : authorized.filter((message) => cursorKeyOf(message) > cursor);
  const page = afterCursor.slice(0, pageSize);
  const isTruncated = afterCursor.length > page.length;
  const nextCursor = isTruncated && page.length > 0 ? cursorKeyOf(page[page.length - 1] as CollaborationInboxMessage) : null;

  return {
    isAvailable: true,
    items: page.map(projectItem),
    totalPendingCount: authorized.length,
    skippedUnauthorizedCount,
    nextCursor,
    isTruncated,
    readOnlyNotice:
      "只读：读取不改变消息状态，也不代表已处理；要投递/回复请走既有投递链路。",
  };
}

/**
 * 生产读取端口：读收件箱文件 → 逐条做**只读**权威授权复核 → 构造视图。
 *
 * 收件箱文件不存在 ⇒ 空视图（无消息不是错误）；文件损坏/不可读 ⇒ 明确返回
 * `isAvailable:false`（不伪装成"没有消息"）。
 */
export function createCollaborationInboxReadPort(input: {
  readonly inboxStore: {
    read(recipientAgentInstanceId: string): Promise<CollaborationInboxReadOutcome>;
  };
  readonly authorizationStore: CrossProjectAuthorizationStore;
}): CollaborationInboxReadPort {
  return {
    async readPendingCollaboration(request) {
      let outcome: CollaborationInboxReadOutcome;
      try {
        outcome = await input.inboxStore.read(request.requestingAgentInstanceId);
      } catch {
        return { isAvailable: false, reason: "协作收件箱不可读（读取失败）。" };
      }
      if (outcome.kind === "invalid") {
        return { isAvailable: false, reason: `协作收件箱损坏：${outcome.reason}` };
      }
      const messages = outcome.kind === "valid" ? outcome.snapshot.messages : [];

      const authorizedMessageIdentifiers = new Set<string>();
      for (const message of messages) {
        if (message.state !== "received") {
          continue;
        }
        if (message.recipientAgentInstanceId !== request.requestingAgentInstanceId) {
          continue;
        }
        const verdict = await evaluateAuthoritativeAuthorization({
          authorizationStore: input.authorizationStore,
          authorizationIdentifier: message.authorizationIdentifier ?? null,
          authorizationEpoch: message.authorizationEpoch,
        });
        if (verdict.isAuthorized) {
          authorizedMessageIdentifiers.add(message.messageIdentifier);
        }
      }

      return buildPendingCollaborationView({
        messages,
        requestingAgentInstanceId: request.requestingAgentInstanceId,
        authorizedMessageIdentifiers,
        ...(request.pageSize === undefined ? {} : { pageSize: request.pageSize }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
    },
  };
}
