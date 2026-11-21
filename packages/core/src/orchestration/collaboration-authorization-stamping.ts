/**
 * COORD-02 §7（2026-11-19）：**生产侧盖章**——由本地可信入口写入授权章。
 *
 * 规则：
 * - 章（关系标识 + 整数代际）**只能**从权威授权存储读取，不接受调用方/模型自报的值；
 * - 关系必须是 `active` 且未过期，否则拒绝入箱（不给"先入箱再验"的机会）；
 * - 本模块不判断业务是否完成，也不代替权限/范围门禁。
 */
import type { CollaborationInbox } from "./collaboration-inbox.js";
import type { CrossProjectAuthorizationStore } from "./cross-project-authorization-store.js";

/**
 * 传输层"原样携带"的关系标识判定（COORD-02 §7「生产与传输」）。
 *
 * 只有**非空字符串**才算带着关系标识；空串/空白/非字符串一律视为**未提供**，
 * 不写 null、不写空串——把"没有章"伪装成"已盖章"会让消费侧误判。
 */
export function carriedAuthorizationIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() === "" ? undefined : value;
}

export type AuthorizationStampOutcome =
  | {
      readonly kind: "stamped";
      readonly authorizationIdentifier: string;
      readonly authorizationEpoch: number;
    }
  | {
      readonly kind: "refused";
      readonly code:
        | "authorization-missing"
        | "authorization-revoked"
        | "authorization-expired"
        | "authorization-unreadable";
      readonly detail: string;
    };

/** 从权威存储解析盖章；失败返回可诊断的拒绝码。 */
export async function resolveAuthorizationStamp(input: {
  readonly authorizationStore: CrossProjectAuthorizationStore;
  readonly authorizationIdentifier: string;
  readonly nowIso: string;
}): Promise<AuthorizationStampOutcome> {
  if (input.authorizationIdentifier.trim() === "") {
    return { kind: "refused", code: "authorization-missing", detail: "缺少授权关系标识。" };
  }
  let record: Awaited<ReturnType<CrossProjectAuthorizationStore["getAuthorization"]>>;
  try {
    await input.authorizationStore.ensureLoaded();
    record = await input.authorizationStore.getAuthorization(input.authorizationIdentifier);
  } catch {
    return { kind: "refused", code: "authorization-unreadable", detail: "权威授权存储暂不可读。" };
  }
  if (record === null) {
    return {
      kind: "refused",
      code: "authorization-missing",
      detail: `权威存储中查不到授权关系 ${input.authorizationIdentifier}。`,
    };
  }
  if (record.state === "revoked") {
    return {
      kind: "refused",
      code: "authorization-revoked",
      detail: `授权关系已被撤销（${String(record.revokedReason ?? "无理由")}）。`,
    };
  }
  const expiresAtMilliseconds = Date.parse(record.expiresAtIso);
  if (Number.isFinite(expiresAtMilliseconds) && expiresAtMilliseconds <= Date.parse(input.nowIso)) {
    return {
      kind: "refused",
      code: "authorization-expired",
      detail: `授权关系已过期（${record.expiresAtIso}）：即使代际相同也不放行。`,
    };
  }
  return {
    kind: "stamped",
    authorizationIdentifier: record.authorizationIdentifier,
    authorizationEpoch: record.authorizationEpoch ?? 1,
  };
}

/**
 * 幂等入箱的**可信入口**：盖章完全取自权威存储，调用方给的 `authorizationEpoch` /
 * `authorizationIdentifier` 一律被忽略（防止模型自报）。
 */
export async function enqueueWithAuthoritativeStamp(input: {
  readonly authorizationStore: CrossProjectAuthorizationStore;
  readonly inbox: CollaborationInbox;
  readonly authorizationIdentifier: string;
  readonly nowIso: string;
  readonly enqueueInput: Record<string, unknown>;
}): Promise<
  | { readonly kind: "enqueued"; readonly authorizationEpoch: number }
  | Extract<AuthorizationStampOutcome, { readonly kind: "refused" }>
> {
  const stamp = await resolveAuthorizationStamp({
    authorizationStore: input.authorizationStore,
    authorizationIdentifier: input.authorizationIdentifier,
    nowIso: input.nowIso,
  });
  if (stamp.kind === "refused") {
    return stamp;
  }
  input.inbox.enqueue({
    ...(input.enqueueInput as object),
    authorizationIdentifier: stamp.authorizationIdentifier,
    authorizationEpoch: stamp.authorizationEpoch,
  } as never);
  return { kind: "enqueued", authorizationEpoch: stamp.authorizationEpoch };
}
