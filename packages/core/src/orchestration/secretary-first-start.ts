/**
 * SECRETARY-01-03（CLIENT-01，2026-10-18 R8）：**次日首次启动判定、同日领取与历史收拢契约**。
 *
 * 卡内依据（`docs/tasks/CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS.md` §2「次日首次启动与历史收拢」）：
 * - 用户设置**时区**与 `minimumClientClosedDurationMinutes`（推荐 360，可调整）；
 * - 判定**同时**满足：跨本地日历日、离线超过阈值、该日未处理；**单纯跨午夜短重启不触发**；
 * - 崩溃导致关闭时刻不确定时**标记估计**、**保守避免重复模型整理**；**多窗口同时启动须原子领取**同日任务；
 * - **只在真实启动时判定**；长开客户端跨日不假装发生首次启动；时钟回拨/DST/改时区用**明确日历策略**与去重记录；
 * - 触发后只把默认视图收拢到"今天"，旧消息**收拢而非删除**，**待决策与未完成事项即使来自昨天也保持可见**；
 * - 历史整理需 CURATE 授权；未授权时只做本地显示调整并提供授权入口；**不阻塞启动/主对话**。
 *
 * ## 边界
 * 纯函数：不读时钟、不写盘、不调模型、不启动服务。时间与判定结果由调用方提供。
 */
import { createHash } from "node:crypto";

/** 计算某瞬间在指定 IANA 时区下的本地日历日（`YYYY-MM-DD`）；非法时区/时间 ⇒ null。 */
export function computeLocalCalendarDate(input: {
  readonly instantIso: string;
  readonly timeZone: string;
}): string | null {
  const instant = new Date(input.instantIso);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year === undefined || month === undefined || day === undefined) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

/** 首次启动判定结论。 */
export type SecretaryFirstStartDecision =
  | {
      readonly kind: "trigger";
      readonly targetLocalDate: string;
      readonly offlineDurationMinutes: number;
      /** 关闭时刻不确定（崩溃）⇒ 估计值；仍按日去重，避免重复整理。 */
      readonly isEstimatedCloseTime: boolean;
      /** 历史整理仍需 CURATE 授权。 */
      readonly requiresCurationAuthorization: true;
      /** 判定本身不得阻塞启动/主对话。 */
      readonly doesBlockStartup: false;
      readonly reason: string;
    }
  | {
      readonly kind: "no-trigger";
      readonly reasonCode:
        | "invalid-configuration"
        | "invalid-timezone"
        | "no-baseline"
        | "clock-rollback"
        | "same-local-day"
        | "closed-too-short"
        | "already-processed"
        | "unknown-close-time";
      readonly reason: string;
    };

/**
 * 判定"今天是否是该客户端次日首次真实启动"。
 *
 * 次序（先安全、再触发）：
 * 1. 阈值必须有效（有限、≥0）；时区必须可解析；
 * 2. 没有任何关闭/心跳基线 ⇒ 不触发（**不假装**发生过首次启动）；
 * 3. `now < 最后活动`（时钟回拨）⇒ 不触发；
 * 4. 与最后活动**同一本地日历日** ⇒ 不触发；
 * 5. 离线时长 **小于**阈值 ⇒ 不触发（**单纯跨午夜短重启不触发**）；
 * 6. 该本地日已处理（有领取/处理记录）⇒ 不触发（**不重复整理**）；
 * 7. 否则触发；关闭时刻缺失时标记"估计"。
 */
export function evaluateSecretaryFirstStartOfDay(input: {
  readonly nowIso: string;
  readonly timeZone: string;
  readonly minimumClientClosedDurationMinutes: number;
  readonly lastClosedAtIso: string | null;
  readonly lastHeartbeatAtIso: string | null;
  readonly lastProcessedLocalDates: ReadonlyArray<string>;
}): SecretaryFirstStartDecision {
  if (
    !Number.isFinite(input.minimumClientClosedDurationMinutes) ||
    input.minimumClientClosedDurationMinutes < 0
  ) {
    return {
      kind: "no-trigger",
      reasonCode: "invalid-configuration",
      reason: "离线阈值无效（必须为有限的非负数分钟）。",
    };
  }

  const nowLocalDate = computeLocalCalendarDate({ instantIso: input.nowIso, timeZone: input.timeZone });
  if (nowLocalDate === null) {
    return {
      kind: "no-trigger",
      reasonCode: "invalid-timezone",
      reason: "时区或当前时间无法解析：不做次日判定。",
    };
  }

  const lastActivityIso = input.lastClosedAtIso ?? input.lastHeartbeatAtIso;
  if (lastActivityIso === null) {
    return {
      kind: "no-trigger",
      reasonCode: "no-baseline",
      reason: "没有关闭/心跳基线（首次安装或记录缺失）：不触发整理。",
    };
  }

  const lastActivityMilliseconds = Date.parse(lastActivityIso);
  const nowMilliseconds = Date.parse(input.nowIso);
  if (Number.isNaN(lastActivityMilliseconds) || Number.isNaN(nowMilliseconds)) {
    return {
      kind: "no-trigger",
      reasonCode: "no-baseline",
      reason: "最后活动或当前时间无法解析：不触发整理。",
    };
  }
  if (nowMilliseconds < lastActivityMilliseconds) {
    return {
      kind: "no-trigger",
      reasonCode: "clock-rollback",
      reason: "检测到时钟回拨（当前时间早于最后活动）：不触发，避免重复整理。",
    };
  }

  const lastActivityLocalDate = computeLocalCalendarDate({
    instantIso: lastActivityIso,
    timeZone: input.timeZone,
  });
  if (lastActivityLocalDate === null) {
    return {
      kind: "no-trigger",
      reasonCode: "invalid-timezone",
      reason: "最后活动时间无法按给定时区解析。",
    };
  }
  if (lastActivityLocalDate === nowLocalDate) {
    return {
      kind: "no-trigger",
      reasonCode: "same-local-day",
      reason: "与最后活动处于同一本地日历日：不视为次日首次启动。",
    };
  }

  const offlineDurationMinutes = (nowMilliseconds - lastActivityMilliseconds) / 60_000;
  if (offlineDurationMinutes < input.minimumClientClosedDurationMinutes) {
    return {
      kind: "no-trigger",
      reasonCode: "closed-too-short",
      reason: `离线 ${offlineDurationMinutes.toFixed(1)} 分钟 < 阈值 ${String(input.minimumClientClosedDurationMinutes)} 分钟：单纯跨午夜短重启不触发。`,
    };
  }

  if (input.lastProcessedLocalDates.includes(nowLocalDate)) {
    return {
      kind: "no-trigger",
      reasonCode: "already-processed",
      reason: `本地日历日 ${nowLocalDate} 已处理：不重复整理。`,
    };
  }

  const isEstimatedCloseTime = input.lastClosedAtIso === null;
  if (isEstimatedCloseTime && input.lastHeartbeatAtIso === null) {
    return {
      kind: "no-trigger",
      reasonCode: "unknown-close-time",
      reason: "关闭时刻与心跳都缺失：无法估计离线时长，保守不触发。",
    };
  }

  return {
    kind: "trigger",
    targetLocalDate: nowLocalDate,
    offlineDurationMinutes: Math.round(offlineDurationMinutes * 10) / 10,
    isEstimatedCloseTime,
    requiresCurationAuthorization: true,
    doesBlockStartup: false,
    reason: isEstimatedCloseTime
      ? "跨日且离线超过阈值（关闭时刻为估计值）：触发一次整理，按日去重。"
      : "跨日且离线超过阈值：触发次日首次整理。",
  };
}

/** 同日处理领取记录（多窗口原子领取的去重依据）。 */
export interface SecretaryDailyProcessingClaimV1 {
  readonly schemaVersion: 1;
  readonly localDate: string;
  readonly claimantWindowIdentifier: string;
  readonly claimedAtIso: string;
  readonly claimIdentifier: string;
}

export type DailyClaimOutcome =
  | { readonly kind: "claimed"; readonly claim: SecretaryDailyProcessingClaimV1 }
  | {
      readonly kind: "already-claimed";
      readonly existingClaim: SecretaryDailyProcessingClaimV1;
      readonly reason: string;
    };

/**
 * 领取某个本地日历日的处理任务（**同日只能被领取一次**）。
 *
 * - 已有同 `localDate` 的领取 ⇒ `already-claimed`（**多窗口不重复整理**；同一窗口重放同样如此）；
 * - 否则发放领取记录。真实持久化应由调用方用原子写落盘（本函数只判定）。
 */
export function applyDailyProcessingClaim(input: {
  readonly existingClaims: ReadonlyArray<SecretaryDailyProcessingClaimV1>;
  readonly localDate: string;
  readonly claimantWindowIdentifier: string;
  readonly claimedAtIso: string;
}): DailyClaimOutcome {
  const existing = input.existingClaims.find((claim) => claim.localDate === input.localDate);
  if (existing !== undefined) {
    return {
      kind: "already-claimed",
      existingClaim: existing,
      reason:
        existing.claimantWindowIdentifier === input.claimantWindowIdentifier
          ? "同一窗口已领取该日任务（幂等重放）。"
          : "该日任务已被另一个窗口领取：不重复整理。",
    };
  }
  const claimIdentifier =
    "secretary-daily-claim:" +
    createHash("sha256")
      .update(JSON.stringify([input.localDate, input.claimantWindowIdentifier]))
      .digest("hex")
      .slice(0, 24);
  return {
    kind: "claimed",
    claim: {
      schemaVersion: 1,
      localDate: input.localDate,
      claimantWindowIdentifier: input.claimantWindowIdentifier,
      claimedAtIso: input.claimedAtIso,
      claimIdentifier,
    },
  };
}

/** 摘要分类（完成/待验收/待人工追认/未完成/待决策**分开**）。 */
export type SecretarySummaryCategory =
  | "completed"
  | "pending-acceptance"
  | "pending-human-attestation"
  | "unfinished"
  | "needs-decision";

/** 一条消息/事项（收拢视图的输入）。 */
export interface SecretaryViewItem {
  readonly messageIdentifier: string;
  readonly localDate: string;
  readonly category: SecretarySummaryCategory;
  readonly projectIdentifier: string;
  readonly recordedAtIso: string;
}

/** 收拢视图结论。 */
export interface CollapsedSecretaryView {
  readonly visibleItems: ReadonlyArray<SecretaryViewItem>;
  /** 被收拢（仍保留在本地历史）的旧条目数。 */
  readonly collapsedOlderCount: number;
  /** **收拢不等于删除**：恒为 false。 */
  readonly areOlderDeleted: false;
  /** 旧但属于"待决策/未完成"、因此仍可见的条目数。 */
  readonly oldPendingItemsVisibleCount: number;
  readonly quickEntries: ReadonlyArray<
    "today-schedule" | "completed" | "unfinished" | "needs-my-decision"
  >;
  readonly reason: string;
}

/**
 * 构建收拢视图。
 *
 * 规则（卡内）：
 * - 默认只看"今天"；旧条目**收拢而非删除**（`areOlderDeleted` 恒 false）；
 * - **待决策与未完成**事项即使来自昨天也**保持可见**；
 * - 无论是否收拢，快捷入口固定四项；摘要分类彼此分开（不合并"完成/待验收/待追认"）。
 */
export function buildCollapsedSecretaryView(input: {
  readonly items: ReadonlyArray<SecretaryViewItem>;
  readonly todayLocalDate: string;
  readonly showAllHistory: boolean;
}): CollapsedSecretaryView {
  const isPendingItem = (item: SecretaryViewItem): boolean =>
    item.category === "needs-decision" || item.category === "unfinished";

  if (input.showAllHistory) {
    return {
      visibleItems: input.items,
      collapsedOlderCount: 0,
      areOlderDeleted: false,
      oldPendingItemsVisibleCount: input.items.filter(
        (item) => item.localDate !== input.todayLocalDate && isPendingItem(item),
      ).length,
      quickEntries: ["today-schedule", "completed", "unfinished", "needs-my-decision"],
      reason: "用户选择显示全部历史：不收拢（切换只影响显示，不影响保存）。",
    };
  }

  const visibleItems = input.items.filter(
    (item) => item.localDate === input.todayLocalDate || isPendingItem(item),
  );
  const collapsedOlderCount = input.items.filter(
    (item) => item.localDate !== input.todayLocalDate && !isPendingItem(item),
  ).length;

  return {
    visibleItems,
    collapsedOlderCount,
    areOlderDeleted: false,
    oldPendingItemsVisibleCount: input.items.filter(
      (item) => item.localDate !== input.todayLocalDate && isPendingItem(item),
    ).length,
    quickEntries: ["today-schedule", "completed", "unfinished", "needs-my-decision"],
    reason:
      collapsedOlderCount === 0
        ? "没有需要收拢的旧条目。"
        : `已将 ${String(collapsedOlderCount)} 条旧条目收拢到历史（未删除）；旧待决策/未完成仍可见。`,
  };
}
