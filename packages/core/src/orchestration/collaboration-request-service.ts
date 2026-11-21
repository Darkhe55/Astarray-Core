/**
 * 2026-11-21（用户裁决）：**协作请求的生产发送入口**（SDK / CLI 共用）。
 *
 * 一次调用完成五步，全部 fail-closed：
 * 1. **地址完整性**：收件人必须已登记且未回收；不能发给自己；
 * 2. **层级规则**：三级/四级只能发给唯一直属上级（其余协作由上级代理转达）；
 * 3. **授权章**：同项目首次发送**自动登记默认关系**（epoch 1，可撤销、撤销后不复活）；
 *    跨项目必须带显式授权标识，并核对收件人/项目范围；
 * 4. **入箱 + 持久化**（revision 冲突重试一次，不覆盖他人更新）；
 * 5. **投递**（可选传输端口；投递前按权威代际复核，失败保留 pending）。
 *
 * 边界：本模块不判断业务是否完成；读取仍走 `taskSequenceStatus` 的只读出口。
 */
import { createHash, randomUUID } from "node:crypto";

import type { AgentRole } from "../core/types.js";
import {
  CollaborationInbox,
  type CollaborationInboxMessage,
} from "./collaboration-inbox.js";
import {
  CollaborationInboxRevisionConflictError,
  type CollaborationInboxStore,
} from "./collaboration-inbox-store.js";
import type { CollaborationInboxTransportPort } from "./collaboration-inbox-delivery.js";
import { CollaborationInboxDeliveryService } from "./collaboration-inbox-delivery.js";
import type { CrossProjectAuthorizationStore } from "./cross-project-authorization-store.js";
import { evaluateAuthoritativeAuthorization } from "./collaboration-authoritative-delivery.js";

export type CollaborationRequestRefusalCode =
  | "invalid-input"
  | "recipient-not-a-known-agent"
  | "recipient-recycled"
  | "self-addressed"
  | "relay-required"
  | "authorization-missing"
  | "authorization-revoked"
  | "authorization-expired"
  | "authorization-unreadable"
  | "authorization-scope-mismatch"
  | "inbox-unavailable"
  | "inbox-rejected";

export interface SendCollaborationRequestInput {
  readonly senderAgentInstanceId: string;
  /** 发送者层级（可空 ⇒ 不校验转达规则；工具入口由 harness 注入真实层级）。 */
  readonly senderRole?: AgentRole | null;
  readonly recipientAgentInstanceId: string;
  readonly taskIdentifier: string;
  readonly missionIdentifier?: string | null;
  readonly summary: string;
  readonly correlationIdentifier?: string | null;
  /** 幂等：同一 requestIdentifier 复用同一 messageIdentifier。 */
  readonly requestIdentifier?: string | null;
  readonly replyToMessageIdentifier?: string | null;
  readonly artifactReferences?: ReadonlyArray<{
    readonly artifactIdentifier: string;
    readonly revision: number;
  }>;
  readonly nowIso: string;
  readonly projectScope: "same-project" | "cross-project";
  /** 跨项目必填（同项目忽略）。 */
  readonly authorizationIdentifier?: string | null;
  readonly sourceProjectIdentifier?: string | null;
  readonly targetProjectIdentifier?: string | null;
}

export type CollaborationRequestOutcome =
  | {
      readonly kind: "sent" | "duplicate";
      readonly messageIdentifier: string;
      readonly authorizationIdentifier: string;
      readonly authorizationEpoch: number;
      readonly inboxState: string;
      readonly isDelivered: boolean;
      readonly deliveryReason: string;
    }
  | {
      readonly kind: "refused";
      readonly code: CollaborationRequestRefusalCode;
      readonly reason: string;
    };

export interface CollaborationRequestServiceDeps {
  readonly inboxStore: CollaborationInboxStore;
  readonly authorizationStore: CrossProjectAuthorizationStore;
  /** 传输端口；缺省 ⇒ 只入箱不投递（调用方之后可再投）。 */
  readonly transport?: CollaborationInboxTransportPort | null;
  readonly isRecipientKnown?: (agentInstanceId: string) => Promise<boolean>;
  readonly uniqueParentOf?: (agentInstanceId: string) => Promise<string | null>;
  readonly maximumPendingPerRecipient?: number;
  readonly maximumDeliveryAttempts?: number;
}

function deriveMessageIdentifier(
  senderAgentInstanceId: string,
  requestIdentifier: string | null | undefined,
): string {
  if (requestIdentifier === null || requestIdentifier === undefined || requestIdentifier === "") {
    return "message:" + randomUUID();
  }
  return (
    "message:" +
    createHash("sha256")
      .update(`${senderAgentInstanceId}|${requestIdentifier}`)
      .digest("hex")
      .slice(0, 32)
  );
}

const TERMINAL_ROLES = new Set<AgentRole>(["tertiary", "quaternary"]);

export async function sendCollaborationRequest(
  deps: CollaborationRequestServiceDeps,
  input: SendCollaborationRequestInput,
): Promise<CollaborationRequestOutcome> {
  const sender = input.senderAgentInstanceId.trim();
  const recipient = input.recipientAgentInstanceId.trim();
  if (sender === "" || recipient === "" || input.taskIdentifier.trim() === "") {
    return { kind: "refused", code: "invalid-input", reason: "发送者/收件人/任务标识不能为空。" };
  }
  if (input.summary.trim() === "") {
    return { kind: "refused", code: "invalid-input", reason: "摘要不能为空。" };
  }
  if (sender === recipient) {
    return { kind: "refused", code: "self-addressed", reason: "不能把协作请求发给自己。" };
  }

  if (deps.isRecipientKnown !== undefined) {
    if (!(await deps.isRecipientKnown(recipient))) {
      return {
        kind: "refused",
        code: "recipient-not-a-known-agent",
        reason: `收件人未登记或已回收：${recipient}（不猜地址）。`,
      };
    }
  }

  /** 三级/四级：只允许发给唯一直属上级；其余协作由上级代理转达。 */
  if (input.senderRole !== null && input.senderRole !== undefined && TERMINAL_ROLES.has(input.senderRole)) {
    if (deps.uniqueParentOf !== undefined) {
      const parent = await deps.uniqueParentOf(sender);
      if (parent === null) {
        return {
          kind: "refused",
          code: "relay-required",
          reason: "发送者没有唯一直属上级：不能直接发起协作（需先建立归属）。",
        };
      }
      if (parent !== recipient) {
        return {
          kind: "refused",
          code: "relay-required",
          reason: `三级/四级只能发给唯一直属上级 ${parent}；对 ${recipient} 的协作须由上级代理转达。`,
        };
      }
    }
  }

  const messageIdentifier = deriveMessageIdentifier(sender, input.requestIdentifier);
  const correlationIdentifier =
    input.correlationIdentifier ?? "correlation:" + randomUUID();

  /** 1. 先定授权章（同项目自动登记默认关系；跨项目用显式授权）。 */
  let authorizationIdentifier: string;
  let authorizationEpoch: number;
  if (input.projectScope === "cross-project") {
    const provided = input.authorizationIdentifier ?? null;
    if (provided === null || provided.trim() === "") {
      return {
        kind: "refused",
        code: "authorization-missing",
        reason: "跨项目协作必须提供授权关系标识。",
      };
    }
    let record: Awaited<ReturnType<CrossProjectAuthorizationStore["getAuthorization"]>>;
    try {
      await deps.authorizationStore.ensureLoaded();
      record = await deps.authorizationStore.getAuthorization(provided);
    } catch {
      return { kind: "refused", code: "authorization-unreadable", reason: "权威授权存储暂不可读。" };
    }
    if (record === null) {
      return { kind: "refused", code: "authorization-missing", reason: `查不到授权关系 ${provided}。` };
    }
    if (record.state === "revoked") {
      return { kind: "refused", code: "authorization-revoked", reason: `授权关系 ${provided} 已撤销。` };
    }
    if (
      record.receivingAgentInstanceId !== null &&
      record.receivingAgentInstanceId !== undefined &&
      record.receivingAgentInstanceId !== recipient
    ) {
      return {
        kind: "refused",
        code: "authorization-scope-mismatch",
        reason: "授权关系的接收个体与本次收件人不一致。",
      };
    }
    if (
      input.sourceProjectIdentifier !== null &&
      input.sourceProjectIdentifier !== undefined &&
      record.sourceProjectIdentifier !== input.sourceProjectIdentifier
    ) {
      return { kind: "refused", code: "authorization-scope-mismatch", reason: "授权关系的源项目不一致。" };
    }
    if (
      input.targetProjectIdentifier !== null &&
      input.targetProjectIdentifier !== undefined &&
      record.targetProjectIdentifier !== input.targetProjectIdentifier
    ) {
      return { kind: "refused", code: "authorization-scope-mismatch", reason: "授权关系的目标项目不一致。" };
    }
    authorizationIdentifier = record.authorizationIdentifier;
    authorizationEpoch = record.authorizationEpoch ?? 1;
  } else {
    const relationship = await deps.authorizationStore.ensureLocalCollaborationRelationship({
      sourceProjectIdentifier: input.sourceProjectIdentifier ?? "same-project",
      targetProjectIdentifier: input.targetProjectIdentifier ?? "same-project",
      sourceAgentInstanceId: sender,
      receivingAgentInstanceId: recipient,
      taskIdentifier: input.taskIdentifier,
      nowIso: input.nowIso,
    });
    if (relationship.outcome === "revoked") {
      return {
        kind: "refused",
        code: "authorization-revoked",
        reason: "同项目默认关系已被撤销：不自动复活，需用户/上级显式重新授权。",
      };
    }
    if (relationship.outcome === "expired") {
      return { kind: "refused", code: "authorization-expired", reason: "同项目默认关系已过期。" };
    }
    if (relationship.record === null) {
      return { kind: "refused", code: "authorization-unreadable", reason: "默认关系登记失败。" };
    }
    authorizationIdentifier = relationship.record.authorizationIdentifier;
    authorizationEpoch = relationship.record.authorizationEpoch ?? 1;
  }

  /** 2. 入箱 + 持久化（revision 冲突重试一次）。 */
  const inboxOptions = {
    maximumPendingPerRecipient: deps.maximumPendingPerRecipient ?? 20,
    maximumDeliveryAttempts: deps.maximumDeliveryAttempts ?? 3,
  } as const;
  let saved = false;
  for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
    const outcome = await deps.inboxStore.read(recipient);
    if (outcome.kind === "invalid") {
      return { kind: "refused", code: "inbox-unavailable", reason: `收件箱损坏：${outcome.reason}` };
    }
    const revision = outcome.kind === "valid" ? outcome.snapshot.revision : 0;
    const inbox =
      outcome.kind === "valid"
        ? CollaborationInbox.fromSnapshot({ messages: outcome.snapshot.messages, ...inboxOptions })
        : new CollaborationInbox(inboxOptions);

    const existing: CollaborationInboxMessage | null = inbox.getMessage(messageIdentifier);
    if (existing !== null) {
      return {
        kind: "duplicate",
        messageIdentifier,
        authorizationIdentifier,
        authorizationEpoch,
        inboxState: existing.state,
        isDelivered: existing.state === "delivered" || existing.state === "completed",
        deliveryReason: "同一 requestIdentifier 已入箱（幂等复用，不重复发送）。",
      };
    }

    const enqueueResult = inbox.enqueue({
      messageIdentifier,
      correlationIdentifier,
      recipientAgentInstanceId: recipient,
      senderAgentInstanceId: sender,
      taskIdentifier: input.taskIdentifier,
      ...(input.missionIdentifier === null || input.missionIdentifier === undefined
        ? {}
        : { missionIdentifier: input.missionIdentifier }),
      ...(input.replyToMessageIdentifier === null || input.replyToMessageIdentifier === undefined
        ? {}
        : { replyToMessageIdentifier: input.replyToMessageIdentifier }),
      ...(input.artifactReferences === undefined
        ? {}
        : { artifactReferences: input.artifactReferences }),
      summary: input.summary,
      receivedAtIso: input.nowIso,
      authorizationIdentifier,
      authorizationEpoch,
    });
    if (enqueueResult.outcome !== "accepted" && enqueueResult.outcome !== "duplicate") {
      return {
        kind: "refused",
        code:
          enqueueResult.outcome === "rejected-backpressure" ? "inbox-rejected" : "inbox-rejected",
        reason: enqueueResult.reason,
      };
    }
    try {
      await deps.inboxStore.save(recipient, {
        messages: inbox.toSnapshot(),
        expectedRevision: revision,
        updatedAtIso: input.nowIso,
      });
      saved = true;
    } catch (error) {
      if (!(error instanceof CollaborationInboxRevisionConflictError)) {
        return { kind: "refused", code: "inbox-unavailable", reason: "收件箱写入失败。" };
      }
      /** 冲突：重读后重试一次（幂等键避免重复插入）。 */
    }
  }
  if (!saved) {
    return { kind: "refused", code: "inbox-unavailable", reason: "收件箱并发冲突，重试后仍未写入。" };
  }

  /** 3. 投递（可选）：投递前按权威代际复核；失败保留 pending。 */
  let isDelivered = false;
  let deliveryReason = "未配置传输端口：只入箱，未投递。";
  if (deps.transport !== null && deps.transport !== undefined) {
    const delivery = new CollaborationInboxDeliveryService({
      store: deps.inboxStore,
      transport: deps.transport,
      options: {
        ...inboxOptions,
        resolveAuthoritativeAuthorizationEpoch: async (message) => {
          const verdict = await evaluateAuthoritativeAuthorization({
            authorizationStore: deps.authorizationStore,
            authorizationIdentifier: message.authorizationIdentifier ?? null,
            authorizationEpoch: message.authorizationEpoch,
          });
          return verdict.isAuthorized
            ? { kind: "authorized", epoch: verdict.authorizationEpoch }
            : { kind: "rejected", code: verdict.rejectionCode, detail: verdict.reason };
        },
      },
    });
    const report = await delivery.deliverPendingForRecipient({
      recipientAgentInstanceId: recipient,
      nowIso: input.nowIso,
    });
    isDelivered = report.deliveredCount > 0;
    deliveryReason = report.reason;
  }

  const persisted = await deps.inboxStore.read(recipient);
  const inboxState =
    persisted.kind === "valid"
      ? persisted.snapshot.messages.find((message) => message.messageIdentifier === messageIdentifier)
          ?.state ?? "received"
      : "received";
  return {
    kind: "sent",
    messageIdentifier,
    authorizationIdentifier,
    authorizationEpoch,
    inboxState,
    isDelivered,
    deliveryReason,
  };
}
