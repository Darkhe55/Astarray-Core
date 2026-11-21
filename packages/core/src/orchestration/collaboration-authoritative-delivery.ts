/**
 * COORD-02 §7（2026-11-19）：**消费侧按权威授权复核**。
 *
 * 规则（卡内要求）：
 * - 需授权且**缺章/0**、**关系查不到**、**已撤销**、**旧代** ⇒ 不入上下文、不确认已消费；
 * - 拒绝时保留 pending 并记录可诊断原因（`recordDeliveryFailure`），供后续重试/查阅；
 * - 只有权威存储里的**当前代际**与消息一致才允许投递。
 *
 * 边界：本模块只做"投递前复核"，不判断业务是否完成，也不代替权限/范围门禁。
 */
import type { CollaborationInbox } from "./collaboration-inbox.js";
import type { CrossProjectAuthorizationStore } from "./cross-project-authorization-store.js";

export type AuthoritativeDeliveryRejectionCode =
  | "message-missing"
  | "authorization-missing"
  | "authorization-unreadable"
  | "authorization-revoked"
  | "authorization-epoch-stale"
  | "authorization-epoch-absent";

export type AuthoritativeDeliveryOutcome =
  | { readonly isDelivered: true; readonly authorizationEpoch: number; readonly reason: string }
  | {
      readonly isDelivered: false;
      readonly rejectionCode: AuthoritativeDeliveryRejectionCode;
      readonly reason: string;
      readonly deliveryAttemptCount: number;
    };

export async function deliverWithAuthoritativeAuthorization(input: {
  readonly authorizationStore: CrossProjectAuthorizationStore;
  readonly inbox: CollaborationInbox;
  readonly messageIdentifier: string;
  readonly deliveredAtIso: string;
}): Promise<AuthoritativeDeliveryOutcome> {
  const message = input.inbox.getMessage(input.messageIdentifier);
  if (message === null) {
    return {
      isDelivered: false,
      rejectionCode: "message-missing",
      reason: "消息不存在。",
      deliveryAttemptCount: 0,
    };
  }

  const reject = (
    rejectionCode: AuthoritativeDeliveryRejectionCode,
    reason: string,
  ): AuthoritativeDeliveryOutcome => {
    const failure = input.inbox.recordDeliveryFailure(input.messageIdentifier, input.deliveredAtIso);
    return {
      isDelivered: false,
      rejectionCode,
      reason: `${reason}（保留 pending，交付尝试 ${String(failure.deliveryAttemptCount)} 次）`,
      deliveryAttemptCount: failure.deliveryAttemptCount,
    };
  };

  const verdict = await evaluateAuthoritativeAuthorization({
    authorizationStore: input.authorizationStore,
    authorizationIdentifier: message.authorizationIdentifier ?? null,
    authorizationEpoch: message.authorizationEpoch,
  });
  if (!verdict.isAuthorized) {
    return reject(verdict.rejectionCode, verdict.reason);
  }
  const currentEpoch = verdict.authorizationEpoch;

  const delivered = input.inbox.markDelivered(input.messageIdentifier, input.deliveredAtIso, {
    currentAuthorizationEpoch: currentEpoch,
  });
  if (!delivered.isDelivered) {
    return reject("authorization-epoch-stale", delivered.reason);
  }
  return {
    isDelivered: true,
    authorizationEpoch: currentEpoch,
    reason: delivered.reason,
  };
}

/** 授权复核的拒绝码（`message-missing` 只属于投递路径，不在此列）。 */
export type AuthoritativeAuthorizationRejectionCode = Exclude<
  AuthoritativeDeliveryRejectionCode,
  "message-missing"
>;

export type AuthoritativeAuthorizationVerdict =
  | { readonly isAuthorized: true; readonly authorizationEpoch: number }
  | {
      readonly isAuthorized: false;
      readonly rejectionCode: AuthoritativeAuthorizationRejectionCode;
      readonly reason: string;
    };

/**
 * 2026-11-21（用户裁决 A）：**只读**的权威授权判定。
 *
 * 与投递前的复核使用同一套规则，但**不记录交付失败、不改变消息状态**——
 * 协作消息的"读取出口"必须无副作用（读取 ≠ 投递 ≠ 确认）。
 */
export async function evaluateAuthoritativeAuthorization(input: {
  readonly authorizationStore: CrossProjectAuthorizationStore;
  readonly authorizationIdentifier: string | null | undefined;
  readonly authorizationEpoch: number;
}): Promise<AuthoritativeAuthorizationVerdict> {
  const authorizationIdentifier = input.authorizationIdentifier ?? null;
  if (authorizationIdentifier === null || authorizationIdentifier.trim() === "") {
    /** 历史消息/缺字段：不能把"没有章"当作免验。 */
    return {
      isAuthorized: false,
      rejectionCode: "authorization-missing",
      reason: "消息缺少权威授权关系标识：不视为已授权。",
    };
  }

  let record: Awaited<ReturnType<CrossProjectAuthorizationStore["getAuthorization"]>>;
  try {
    await input.authorizationStore.ensureLoaded();
    record = await input.authorizationStore.getAuthorization(authorizationIdentifier);
  } catch {
    return {
      isAuthorized: false,
      rejectionCode: "authorization-unreadable",
      reason: "权威授权存储暂不可读（不忙轮询）。",
    };
  }

  if (record === null) {
    return {
      isAuthorized: false,
      rejectionCode: "authorization-missing",
      reason: `权威存储中查不到授权关系 ${authorizationIdentifier}。`,
    };
  }
  if (record.state === "revoked") {
    return {
      isAuthorized: false,
      rejectionCode: "authorization-revoked",
      reason: `授权关系 ${authorizationIdentifier} 已被撤销（${String(
        record.revokedReason ?? "无理由",
      )}）。`,
    };
  }

  const currentEpoch = record.authorizationEpoch ?? 1;
  if (input.authorizationEpoch <= 0) {
    return {
      isAuthorized: false,
      rejectionCode: "authorization-epoch-absent",
      reason: "消息授权代为 0（缺章）。",
    };
  }
  if (input.authorizationEpoch !== currentEpoch) {
    return {
      isAuthorized: false,
      rejectionCode: "authorization-epoch-stale",
      reason: `授权代已变更（入箱 ${String(input.authorizationEpoch)}，当前 ${String(
        currentEpoch,
      )}）。`,
    };
  }
  return { isAuthorized: true, authorizationEpoch: currentEpoch };
}