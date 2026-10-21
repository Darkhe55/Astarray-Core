/**
 * USAGE-01-02（2026-10-21）：**预算预留与结算**（token / 请求数）。
 *
 * 卡内判据：持久化去重、分页聚合、**预算**及估价；反例：重复事件、**乱序终值**、**重启**、
 * **跨模型切换**、**取消缺 usage**、**并发预算**。
 *
 * 本模块只做**预算预留/结算**这一缺口（聚合与去重已在 `usage-ledger-store.ts`）。
 *
 * 口径（默认，待用户确认）：
 * 1. **金额估价不做**：无价目 ⇒ 一律"未估算"，本模块只限 token 与请求数；
 * 2. **未知 usage 不释放预留**（保守）：取消/缺 usage ⇒ 预留保持占用并标 `consumed-unknown`，
 *    因此后续调用可能被拒——宁可拒绝也不虚报"未超预算"；
 * 3. **并发原子性靠 revision**：`expectedRevision` 不符 ⇒ `stale-revision`（调用方重读重试），
 *    不做"最后写入者赢"；
 * 4. **跨模型不混账**：预留绑定 `modelIdentifier`，视图可按模型过滤；换模型**不清除**旧预留。
 */
import { createHash } from "node:crypto";

/** 预算策略（默认值待用户确认）。 */
export interface UsageBudgetPolicy {
  readonly inputTokenLimit: number;
  readonly requestLimit: number;
}

/** 预留状态。 */
export type UsageReservationStatus = "reserved" | "settled" | "consumed-unknown";

/** 单条预留。 */
export interface UsageReservation {
  readonly reservationIdentifier: string;
  readonly modelIdentifier: string;
  readonly reservedInputTokenCount: number;
  readonly reservedRequestCount: number;
  readonly status: UsageReservationStatus;
  /** 结算后的实际用量（未知时为 null）。 */
  readonly settledInputTokenCount: number | null;
  readonly settledRequestCount: number | null;
}

/** 持久化状态（调用方负责落盘；本模块纯函数）。 */
export interface UsageBudgetState {
  readonly revision: number;
  readonly reservations: ReadonlyArray<UsageReservation>;
}

/** 空状态。 */
export function createUsageBudgetState(): UsageBudgetState {
  return { revision: 0, reservations: [] };
}

/** 预留结果。 */
export type UsageBudgetReserveOutcome =
  | {
      readonly kind: "reserved";
      readonly state: UsageBudgetState;
      readonly reservationIdentifier: string;
    }
  | {
      readonly kind: "denied";
      readonly reasonCode:
        | "would-exceed-token-budget"
        | "would-exceed-request-budget"
        | "invalid-request"
        | "duplicate-reservation";
      readonly reason: string;
      readonly state: UsageBudgetState;
    }
  | { readonly kind: "stale-revision"; readonly reason: string; readonly state: UsageBudgetState };

/** 结算结果。 */
export type UsageBudgetSettleOutcome =
  | {
      readonly kind: "settled";
      readonly state: UsageBudgetState;
      readonly releasedInputTokenCount: number;
      readonly releasedRequestCount: number;
    }
  | {
      readonly kind: "kept-conservative";
      readonly state: UsageBudgetState;
      readonly reason: string;
    }
  | { readonly kind: "stale-revision"; readonly reason: string; readonly state: UsageBudgetState }
  | { readonly kind: "unknown-reservation"; readonly state: UsageBudgetState; readonly reason: string };

/** 视图（供展示"已用/预留/剩余/是否可判定"）。 */
export interface UsageBudgetView {
  readonly settledInputTokenCount: number;
  readonly reservedInputTokenCount: number;
  readonly settledRequestCount: number;
  readonly reservedRequestCount: number;
  readonly remainingInputTokenCount: number;
  readonly remainingRequestCount: number;
  /** 存在未知用量 ⇒ 剩余值**不可靠**，UI 必须显示"不可判定"。 */
  readonly isDeterminable: boolean;
  readonly hasUnknownUsage: boolean;
}

function sum(values: ReadonlyArray<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** 计算视图（可按模型过滤；不传则全部模型）。 */
export function evaluateUsageBudgetView(input: {
  readonly state: UsageBudgetState;
  readonly policy: UsageBudgetPolicy;
  readonly modelIdentifier?: string | null;
}): UsageBudgetView {
  const scope =
    input.modelIdentifier === undefined || input.modelIdentifier === null
      ? input.state.reservations
      : input.state.reservations.filter(
          (reservation) => reservation.modelIdentifier === input.modelIdentifier,
        );

  const settled = scope.filter((reservation) => reservation.status === "settled");
  const active = scope.filter((reservation) => reservation.status !== "settled");
  const settledInputTokenCount = sum(settled.map((reservation) => reservation.settledInputTokenCount));
  const settledRequestCount = sum(settled.map((reservation) => reservation.settledRequestCount));
  const reservedInputTokenCount = sum(active.map((reservation) => reservation.reservedInputTokenCount));
  const reservedRequestCount = sum(active.map((reservation) => reservation.reservedRequestCount));
  const hasUnknownUsage = scope.some((reservation) => reservation.status === "consumed-unknown");

  return {
    settledInputTokenCount,
    reservedInputTokenCount,
    settledRequestCount,
    reservedRequestCount,
    remainingInputTokenCount: Math.max(
      0,
      input.policy.inputTokenLimit - settledInputTokenCount - reservedInputTokenCount,
    ),
    remainingRequestCount: Math.max(
      0,
      input.policy.requestLimit - settledRequestCount - reservedRequestCount,
    ),
    isDeterminable: !hasUnknownUsage,
    hasUnknownUsage,
  };
}

/** 预留预算（并发安全靠 revision）。 */
export function reserveUsageBudget(input: {
  readonly state: UsageBudgetState;
  readonly policy: UsageBudgetPolicy;
  readonly expectedRevision: number;
  readonly reservationIdentifier: string;
  readonly modelIdentifier: string;
  readonly estimatedInputTokenCount: number;
  readonly requestCount: number;
}): UsageBudgetReserveOutcome {
  if (input.expectedRevision !== input.state.revision) {
    return {
      kind: "stale-revision",
      reason: `revision 不符（期望 ${String(input.expectedRevision)}，实际 ${String(input.state.revision)}）：请重读后重试，不覆盖并发写入。`,
      state: input.state,
    };
  }
  if (
    !Number.isFinite(input.estimatedInputTokenCount) ||
    input.estimatedInputTokenCount < 0 ||
    !Number.isFinite(input.requestCount) ||
    input.requestCount <= 0
  ) {
    return {
      kind: "denied",
      reasonCode: "invalid-request",
      reason: "预留请求不合法（token 数非负、请求数 ≥1）。",
      state: input.state,
    };
  }
  if (
    input.state.reservations.some(
      (reservation) => reservation.reservationIdentifier === input.reservationIdentifier,
    )
  ) {
    return {
      kind: "denied",
      reasonCode: "duplicate-reservation",
      reason: "同一预留 ID 已存在：不重复占用（重试请复用已有预留）。",
      state: input.state,
    };
  }

  const view = evaluateUsageBudgetView({
    state: input.state,
    policy: input.policy,
    modelIdentifier: input.modelIdentifier,
  });
  if (view.settledInputTokenCount + view.reservedInputTokenCount + input.estimatedInputTokenCount > input.policy.inputTokenLimit) {
    return {
      kind: "denied",
      reasonCode: "would-exceed-token-budget",
      reason:
        "预留后将超出 token 预算（已用 " +
        String(view.settledInputTokenCount) +
        " + 已预留 " +
        String(view.reservedInputTokenCount) +
        " + 本次 " +
        String(input.estimatedInputTokenCount) +
        " > " +
        String(input.policy.inputTokenLimit) +
        "）。",
      state: input.state,
    };
  }
  if (view.settledRequestCount + view.reservedRequestCount + input.requestCount > input.policy.requestLimit) {
    return {
      kind: "denied",
      reasonCode: "would-exceed-request-budget",
      reason:
        "预留后将超出请求数预算（已用 " +
        String(view.settledRequestCount) +
        " + 已预留 " +
        String(view.reservedRequestCount) +
        " + 本次 " +
        String(input.requestCount) +
        " > " +
        String(input.policy.requestLimit) +
        "）。",
      state: input.state,
    };
  }

  const nextState: UsageBudgetState = {
    revision: input.state.revision + 1,
    reservations: [
      ...input.state.reservations,
      {
        reservationIdentifier: input.reservationIdentifier,
        modelIdentifier: input.modelIdentifier,
        reservedInputTokenCount: input.estimatedInputTokenCount,
        reservedRequestCount: input.requestCount,
        status: "reserved",
        settledInputTokenCount: null,
        settledRequestCount: null,
      },
    ],
  };
  return { kind: "reserved", state: nextState, reservationIdentifier: input.reservationIdentifier };
}

/**
 * 结算预留。
 *
 * - `isUsageKnown:true` ⇒ 写入实际用量并释放预留；
 * - `isUsageKnown:false`（取消/Provider 未给 usage）⇒ **保留占用**并标 `consumed-unknown`（保守）。
 */
export function settleUsageBudget(input: {
  readonly state: UsageBudgetState;
  readonly expectedRevision: number;
  readonly reservationIdentifier: string;
  readonly isUsageKnown: boolean;
  readonly actualInputTokenCount?: number;
  readonly actualRequestCount?: number;
}): UsageBudgetSettleOutcome {
  if (input.expectedRevision !== input.state.revision) {
    return {
      kind: "stale-revision",
      reason: `revision 不符（期望 ${String(input.expectedRevision)}，实际 ${String(input.state.revision)}）。`,
      state: input.state,
    };
  }
  const index = input.state.reservations.findIndex(
    (reservation) => reservation.reservationIdentifier === input.reservationIdentifier,
  );
  if (index < 0) {
    return {
      kind: "unknown-reservation",
      reason: "找不到该预留（可能已被结算或从未建立）。",
      state: input.state,
    };
  }
  const existing = input.state.reservations[index];
  if (existing === undefined) {
    return { kind: "unknown-reservation", reason: "预留条目缺失。", state: input.state };
  }

  if (!input.isUsageKnown) {
    const nextReservations = [...input.state.reservations];
    nextReservations[index] = {
      ...existing,
      status: "consumed-unknown",
      settledInputTokenCount: null,
      settledRequestCount: null,
    };
    return {
      kind: "kept-conservative",
      state: { revision: input.state.revision + 1, reservations: nextReservations },
      reason: "用量未知（取消或 Provider 未返回 usage）：**保留预留不释放**，后续预算判定按最保守口径。",
    };
  }

  const actualInputTokenCount = input.actualInputTokenCount ?? 0;
  const actualRequestCount = input.actualRequestCount ?? existing.reservedRequestCount;
  const nextReservations = [...input.state.reservations];
  nextReservations[index] = {
    ...existing,
    status: "settled",
    settledInputTokenCount: actualInputTokenCount,
    settledRequestCount: actualRequestCount,
  };
  return {
    kind: "settled",
    state: { revision: input.state.revision + 1, reservations: nextReservations },
    releasedInputTokenCount: Math.max(0, existing.reservedInputTokenCount - actualInputTokenCount),
    releasedRequestCount: Math.max(0, existing.reservedRequestCount - actualRequestCount),
  };
}

/**
 * **跨模型切换**：预留按模型分账，切换不清除旧模型预留。
 *
 * 返回切换后的视图提示（旧模型的未知用量仍会影响全局判定）。
 */
export function describeUsageBudgetAfterModelSwitch(input: {
  readonly state: UsageBudgetState;
  readonly policy: UsageBudgetPolicy;
  readonly fromModelIdentifier: string;
  readonly toModelIdentifier: string;
}): {
  readonly fromModelView: UsageBudgetView;
  readonly toModelView: UsageBudgetView;
  readonly carriedOverUnknownUsage: boolean;
  readonly notice: string;
} {
  const fromModelView = evaluateUsageBudgetView({
    state: input.state,
    policy: input.policy,
    modelIdentifier: input.fromModelIdentifier,
  });
  const toModelView = evaluateUsageBudgetView({
    state: input.state,
    policy: input.policy,
    modelIdentifier: input.toModelIdentifier,
  });
  const carriedOverUnknownUsage = fromModelView.hasUnknownUsage || toModelView.hasUnknownUsage;
  return {
    fromModelView,
    toModelView,
    carriedOverUnknownUsage,
    notice: carriedOverUnknownUsage
      ? "切换前后存在未知用量（已保留占用）：预算不可判定，不显示剩余额度为确定值。"
      : "切换后按模型分别记账；旧模型预留仍然生效。",
  };
}

/** 预留指纹（幂等/审计用）。 */
export function computeUsageReservationFingerprint(input: {
  readonly reservationIdentifier: string;
  readonly modelIdentifier: string;
  readonly estimatedInputTokenCount: number;
  readonly requestCount: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.reservationIdentifier,
        input.modelIdentifier,
        input.estimatedInputTokenCount,
        input.requestCount,
      ]),
    )
    .digest("hex");
}
