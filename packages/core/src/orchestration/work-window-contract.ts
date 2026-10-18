/**
 * WORKWINDOW-01-01（2026-10-01 卡，2026-10-18 R14）：工作/休息时段的**规则、时区、作用域、
 * 暂停原因与恢复契约**。
 *
 * 卡内依据（`docs/tasks/2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY_TASK_CARDS.md` §4）：
 * - 用户可选**工作时段白名单**或**休息时段黑名单**，支持周期规则与**一次性例外**；
 *   **默认未设置即全天可工作**；区间**左闭右开**、支持**跨午夜**；
 * - **一次性规则优先于周期规则**；**同优先级冲突时休息优先**；不要复杂优先级引擎；
 * - 默认全局规则向会话/项目继承，**作用域休息约束取交集**；**项目规则不能无声覆盖全局休息**；
 * - 到边界进入 `pausing`，门禁**立即阻止新业务调用**；在途工具**按能力协作取消/保存检查点**，
 *   **不统一 kill**，**不声称无法取消的外部作业已经停止**；
 * - **多个暂停原因分别记录**，**解除时段暂停 ≠ 清除所有暂停原因**；**用户手动暂停/取消优先**；
 * - 开工时**重新检查**时段/用户停止标记/权限/版本/租约/产物与在途副作用，**只恢复安全节点**；
 *   授权失效、紧急状态未解除、外部结果未知的任务**保留阻塞**；
 * - **绝对时刻存 UTC**，周期按选定时区解释；**DST 重复小时不重复启动**、缺失小时按首个有效时刻；
 *   持续时间用**单调时钟**，系统时钟变化触发重算。
 *
 * ## 边界
 * 纯判定：不调度、不取消工具、不写盘、不唤醒系统服务。时间由调用方提供（含虚拟时钟）。
 */
import { createHash } from "node:crypto";

/** 时段规则模式。 */
export type WorkWindowMode = "work-whitelist" | "rest-blacklist";

/** 一条时段规则。 */
export interface WorkWindowRule {
  readonly ruleIdentifier: string;
  readonly mode: WorkWindowMode;
  /** ISO 周几（1=周一 … 7=周日）；一次性例外可不限。 */
  readonly weekdays: ReadonlyArray<number>;
  /** 本地分钟（0–1439），左闭。 */
  readonly startMinuteOfDay: number;
  /** 本地分钟（0–1440），右开；小于 start 表示**跨午夜**。 */
  readonly endMinuteOfDay: number;
  readonly timeZone: string;
  readonly priority: "periodic" | "one-off";
  /** 一次性例外的绝对有效期（UTC）；周期规则为 null。 */
  readonly validFromUtcIso: string | null;
  readonly validUntilUtcIso: string | null;
  readonly scopeKind: "global" | "project" | "session";
}

/** 时段状态。 */
export type WorkWindowState = "working" | "resting";

/** 本地日历信息（用于周期规则匹配）。 */
export interface LocalCalendarMinute {
  readonly localDateIso: string;
  readonly weekday: number;
  readonly minuteOfDay: number;
}

/** 计算某瞬间在指定 IANA 时区下的本地日历分钟；非法时区/时间 ⇒ null。 */
export function computeLocalCalendarMinute(input: {
  readonly instantIso: string;
  readonly timeZone: string;
}): LocalCalendarMinute | null {
  const instant = new Date(input.instantIso);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(instant);
    const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((part) => part.type === type)?.value;
    const year = read("year");
    const month = read("month");
    const day = read("day");
    const hour = read("hour");
    const minute = read("minute");
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined
    ) {
      return null;
    }
    // en-CA 的午夜可能出现 24:00，归一化为 00:00
    const normalizedHour = hour === "24" ? "00" : hour;
    const localDateIso = `${year}-${month}-${day}`;
    // 用 UTC 日期取 ISO 周几（避免本地时区再次影响）
    const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
    // getUTCDay: 0=周日 ⇒ 转成 1..7
    const isoWeekday = weekday === 0 ? 7 : weekday;
    return {
      localDateIso,
      weekday: isoWeekday,
      minuteOfDay: Number(normalizedHour) * 60 + Number(minute),
    };
  } catch {
    return null;
  }
}

/** 分钟是否落在规则区间内（左闭右开，支持跨午夜）。 */
export function isMinuteWithinRuleRange(input: {
  readonly minuteOfDay: number;
  readonly weekday: number;
  readonly rule: WorkWindowRule;
}): boolean {
  const { rule, minuteOfDay, weekday } = input;
  if (rule.weekdays.length > 0 && !rule.weekdays.includes(weekday)) {
    // 跨午夜规则的后半段落在次日，由下面的跨午夜分支单独判断
    if (!(rule.startMinuteOfDay > rule.endMinuteOfDay)) return false;
  }
  if (rule.startMinuteOfDay === rule.endMinuteOfDay) {
    // 空区间（不工作/不休息）
    return false;
  }
  if (rule.startMinuteOfDay < rule.endMinuteOfDay) {
    return minuteOfDay >= rule.startMinuteOfDay && minuteOfDay < rule.endMinuteOfDay;
  }
  // 跨午夜：`[start, 1440)` ∪ `[0, end)`
  const isInEveningPart = minuteOfDay >= rule.startMinuteOfDay;
  const isInMorningPart = minuteOfDay < rule.endMinuteOfDay;
  if (rule.weekdays.length > 0) {
    if (isInEveningPart) return rule.weekdays.includes(weekday);
    if (isInMorningPart) {
      const previousWeekday = weekday === 1 ? 7 : weekday - 1;
      return rule.weekdays.includes(previousWeekday);
    }
  }
  return isInEveningPart || isInMorningPart;
}

/** 判定结论。 */
export interface WorkWindowAssessment {
  readonly state: WorkWindowState;
  readonly matchedRuleIdentifiers: ReadonlyArray<string>;
  readonly reason: string;
}

function isOneOffRuleActive(rule: WorkWindowRule, instantIso: string): boolean {
  if (rule.validFromUtcIso === null || rule.validUntilUtcIso === null) return false;
  const instant = Date.parse(instantIso);
  const from = Date.parse(rule.validFromUtcIso);
  const until = Date.parse(rule.validUntilUtcIso);
  if ([instant, from, until].some((value) => Number.isNaN(value))) return false;
  // 左闭右开
  return instant >= from && instant < until;
}

/**
 * 判定某时刻是否处于工作/休息。
 *
 * 规则次序（卡内）：
 * 1. **没有任何规则** ⇒ **全天可工作**；
 * 2. **一次性例外优先于周期规则**（只在有效期内的例外参与）；
 * 3. 其余按周期规则匹配本地时区的周几+分钟；
 * 4. **休息优先**：同一优先级下只要能判定为休息，就是休息；
 * 5. 白名单模式下，不在任何工作区间内 ⇒ 休息。
 */
export function evaluateWorkWindowState(input: {
  readonly instantIso: string;
  readonly rules: ReadonlyArray<WorkWindowRule>;
}): WorkWindowAssessment {
  if (input.rules.length === 0) {
    return {
      state: "working",
      matchedRuleIdentifiers: [],
      reason: "未设置任何时段规则：默认全天可工作。",
    };
  }

  const oneOffRules = input.rules.filter(
    (rule) => rule.priority === "one-off" && isOneOffRuleActive(rule, input.instantIso),
  );

  const matched: string[] = [];
  let hasRestingMatch = false;
  let hasWorkingMatch = false;
  let effectiveRules: ReadonlyArray<WorkWindowRule> = input.rules;

  if (oneOffRules.length > 0) {
    effectiveRules = oneOffRules;
  }

  for (const rule of effectiveRules) {
    const local = computeLocalCalendarMinute({
      instantIso: input.instantIso,
      timeZone: rule.timeZone,
    });
    if (local === null) {
      // 时区无法解析 ⇒ 保守按休息（不能假装可工作）
      return {
        state: "resting",
        matchedRuleIdentifiers: [rule.ruleIdentifier],
        reason: "规则时区无法解析：保守按休息处理。",
      };
    }
    if (!isMinuteWithinRuleRange({ minuteOfDay: local.minuteOfDay, weekday: local.weekday, rule })) {
      continue;
    }
    matched.push(rule.ruleIdentifier);
    if (rule.mode === "rest-blacklist") hasRestingMatch = true;
    if (rule.mode === "work-whitelist") hasWorkingMatch = true;
  }

  // 作用域交集：任何作用域命中休息 ⇒ 休息（项目规则不能无声覆盖全局休息）
  if (hasRestingMatch) {
    return {
      state: "resting",
      matchedRuleIdentifiers: matched,
      reason: "命中休息规则（同优先级冲突时休息优先；项目规则不能覆盖全局休息）。",
    };
  }
  const hasWhitelist = effectiveRules.some((rule) => rule.mode === "work-whitelist");
  if (hasWhitelist) {
    return hasWorkingMatch
      ? {
          state: "working",
          matchedRuleIdentifiers: matched,
          reason: "命中工作白名单区间。",
        }
      : {
          state: "resting",
          matchedRuleIdentifiers: matched,
          reason: "存在工作白名单但当前不在任何白名单区间内 ⇒ 休息。",
        };
  }
  return {
    state: "working",
    matchedRuleIdentifiers: matched,
    reason: "不在任何休息黑名单区间内。",
  };
}

/**
 * 是否**新进入**工作状态（DST 重复小时不重复启动）。
 *
 * 只有 `previous !== working && current === working` 才算"进入"；重复小时两次评估都是 working ⇒ 不重启。
 */
export function hasEnteredWorkingState(input: {
  readonly previousInstantIso: string;
  readonly currentInstantIso: string;
  readonly rules: ReadonlyArray<WorkWindowRule>;
}): boolean {
  const previous = evaluateWorkWindowState({
    instantIso: input.previousInstantIso,
    rules: input.rules,
  });
  const current = evaluateWorkWindowState({
    instantIso: input.currentInstantIso,
    rules: input.rules,
  });
  return previous.state !== "working" && current.state === "working";
}

/** 暂停原因（**分别记录**，互不覆盖）。 */
export type PauseReasonKind =
  | "work-window"
  | "user-paused"
  | "awaiting-authorization"
  | "emergency"
  | "early-stop";

export interface PauseReasonState {
  readonly pausedReasons: Readonly<Record<PauseReasonKind, boolean>>;
}

/** 初始状态：全部未暂停。 */
export function createPauseReasonState(): PauseReasonState {
  return {
    pausedReasons: {
      "work-window": false,
      "user-paused": false,
      "awaiting-authorization": false,
      emergency: false,
      "early-stop": false,
    },
  };
}

/**
 * 设置/解除**某一个**暂停原因（不影响其他原因）。
 *
 * 卡内：解除时段暂停**不等于**清除所有暂停原因。
 */
export function applyPauseReasonChange(input: {
  readonly current: PauseReasonState;
  readonly reason: PauseReasonKind;
  readonly isPaused: boolean;
}): PauseReasonState {
  return {
    pausedReasons: { ...input.current.pausedReasons, [input.reason]: input.isPaused },
  };
}

/** 是否任一暂停原因生效。 */
export function isAnyPauseReasonActive(state: PauseReasonState): boolean {
  return Object.values(state.pausedReasons).some((isPaused) => isPaused);
}

/** 当前生效的暂停原因（用于如实展示）。 */
export function listActivePauseReasons(state: PauseReasonState): ReadonlyArray<PauseReasonKind> {
  return (Object.keys(state.pausedReasons) as PauseReasonKind[]).filter(
    (reason) => state.pausedReasons[reason],
  );
}

/** 恢复判定结论。 */
export interface ResumeDecision {
  readonly isAllowed: boolean;
  readonly blockedReasonCodes: ReadonlyArray<
    | "resting"
    | "pause-reason-active"
    | "user-stopped"
    | "authorization-invalid"
    | "lease-invalid"
    | "unknown-side-effects"
  >;
  readonly reason: string;
}

/**
 * 开工/恢复门禁。
 *
 * 卡内：开工时**重新检查**时段、用户停止标记、权限、租约、产物与在途副作用，**只恢复安全节点**；
 * 授权失效、紧急状态未解除、外部结果未知的任务**保留阻塞**，不因到点自动放行；
 * **用户手动暂停/取消优先**，不被工作窗口自动撤销。
 */
export function evaluateResume(input: {
  readonly windowState: WorkWindowState;
  readonly pauseReasons: PauseReasonState;
  readonly isUserStopped: boolean;
  readonly isAuthorizationValid: boolean;
  readonly isLeaseValid: boolean;
  readonly hasUnknownSideEffects: boolean;
}): ResumeDecision {
  const blockedReasonCodes: Array<
    | "resting"
    | "pause-reason-active"
    | "user-stopped"
    | "authorization-invalid"
    | "lease-invalid"
    | "unknown-side-effects"
  > = [];
  if (input.windowState === "resting") blockedReasonCodes.push("resting");
  if (isAnyPauseReasonActive(input.pauseReasons)) blockedReasonCodes.push("pause-reason-active");
  if (input.isUserStopped) blockedReasonCodes.push("user-stopped");
  if (!input.isAuthorizationValid) blockedReasonCodes.push("authorization-invalid");
  if (!input.isLeaseValid) blockedReasonCodes.push("lease-invalid");
  if (input.hasUnknownSideEffects) blockedReasonCodes.push("unknown-side-effects");

  return {
    isAllowed: blockedReasonCodes.length === 0,
    blockedReasonCodes,
    reason:
      blockedReasonCodes.length === 0
        ? "时段/暂停/权限/租约/副作用均无阻塞：可只恢复安全节点。"
        : `保留阻塞：${blockedReasonCodes.join("/")}（到点不自动放行）。`,
  };
}

/**
 * 系统时钟跳变检测（持续时间用单调时钟；时钟变化触发重算）。
 *
 * 返回 `hasJumped` 当墙钟差与单调差相差超过阈值。
 */
export function detectWallClockJump(input: {
  readonly previousInstantIso: string;
  readonly currentInstantIso: string;
  readonly previousMonotonicMilliseconds: number;
  readonly currentMonotonicMilliseconds: number;
  readonly toleranceMilliseconds?: number;
}): { readonly hasJumped: boolean; readonly wallClockDeltaMilliseconds: number } {
  const wallClockDeltaMilliseconds =
    Date.parse(input.currentInstantIso) - Date.parse(input.previousInstantIso);
  const monotonicDeltaMilliseconds =
    input.currentMonotonicMilliseconds - input.previousMonotonicMilliseconds;
  const toleranceMilliseconds = input.toleranceMilliseconds ?? 1_000;
  const drift = Math.abs(wallClockDeltaMilliseconds - monotonicDeltaMilliseconds);
  return {
    hasJumped: Number.isFinite(drift) && drift > toleranceMilliseconds,
    wallClockDeltaMilliseconds,
  };
}

/** 规则集合指纹（用于配置 revision 校验与重算）。 */
export function computeWorkWindowRulesFingerprint(rules: ReadonlyArray<WorkWindowRule>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...rules]
          .map((rule) => [
            rule.ruleIdentifier,
            rule.mode,
            [...rule.weekdays].sort(),
            rule.startMinuteOfDay,
            rule.endMinuteOfDay,
            rule.timeZone,
            rule.priority,
            rule.validFromUtcIso,
            rule.validUntilUtcIso,
            rule.scopeKind,
          ])
          .sort(),
      ),
    )
    .digest("hex");
}
