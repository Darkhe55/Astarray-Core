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

  const authorizationIdentifier = message.authorizationIdentifier ?? null;
  if (authorizationIdentifier === null || authorizationIdentifier.trim() === "") {
    /** 历史消息/缺字段：不能把"没有章"当作免验。 */
    return reject("authorization-missing", "消息缺少权威授权关系标识：不投递。");
  }

  let record: Awaited<ReturnType<CrossProjectAuthorizationStore["getAuthorization"]>>;
  try {
    await input.authorizationStore.ensureLoaded();
    record = await input.authorizationStore.getAuthorization(authorizationIdentifier);
  } catch {
    return reject("authorization-unreadable", "权威授权存储暂不可读：不投递（不忙轮询）。");
  }

  if (record === null) {
    return reject(
      "authorization-missing",
      `权威存储中查不到授权关系 ${authorizationIdentifier}：不投递。`,
    );
  }
  if (record.state === "revoked") {
    return reject(
      "authorization-revoked",
      `授权关系 ${authorizationIdentifier} 已被撤销（${String(
        record.revokedReason ?? "无理由",
      )}）：不投递。`,
    );
  }

  const currentEpoch = record.authorizationEpoch ?? 1;
  /** 入箱代 0 / 缺省 ⇒ 视作缺章（历史消息不得因数字相同被放行）。 */
  if (message.authorizationEpoch <= 0) {
    return reject("authorization-epoch-absent", "消息授权代为 0（缺章）：不投递。");
  }
  if (message.authorizationEpoch !== currentEpoch) {
    return reject(
      "authorization-epoch-stale",
      `授权代已变更（入箱 ${String(message.authorizationEpoch)}，当前 ${String(
        currentEpoch,
      )}）：在途旧消息不得落入新任务。`,
    );
  }

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
