/**
 * WORKWINDOW-01-03（2026-10-20）：**恢复语义 + 设置视图 + 停止如实显示**。
 *
 * 卡内判据：设置/对话入口及重启包测试；**睡眠后只恢复一次**、**休息期间无新业务调用**、
 * **手动取消不复活**、**无法停止如实显示**。
 *
 * 这些判据的共同点是"**不能把没做到的说成做到了**"：
 * - 睡眠唤醒后重复恢复 ⇒ 同一任务被跑两次（重复副作用）；
 * - 休息期间仍发新请求 ⇒ 用户以为已停，实际在烧模型；
 * - 手动取消后又被唤醒"复活" ⇒ 用户失去停止能力；
 * - 停止请求超时却显示"已停止" ⇒ 最危险的谎报。
 */
import type { WorkWindowRule } from "./work-window-contract.js";

/** 恢复判定输入。 */
export interface WorkWindowResumeRequest {
  /** 上一次观察到的状态。 */
  readonly previousState: "working" | "resting";
  /** 本次观察到的状态（睡眠唤醒后重新求值得到）。 */
  readonly currentState: "working" | "resting";
  /** 是否存在待恢复的业务（睡眠期间被暂停的调用）。 */
  readonly hasPendingResume: boolean;
  /** 是否已被用户手动取消/暂停（取消后**不得**被唤醒复活）。 */
  readonly isManuallyCancelled: boolean;
  /** 本次唤醒是否已经恢复过一次（由调用方持久化）。 */
  readonly hasResumedSinceWake: boolean;
}

/** 恢复判定结果。 */
export type WorkWindowResumeDecision =
  | { readonly kind: "resume-once"; readonly reason: string }
  | { readonly kind: "already-resumed"; readonly reason: string }
  | { readonly kind: "suppressed-by-manual-cancel"; readonly reason: string }
  | { readonly kind: "no-new-business-calls"; readonly reason: string }
  | { readonly kind: "nothing-pending"; readonly reason: string };

/** 判定"要不要恢复"，且**最多一次**。 */
export function evaluateWorkWindowResume(
  request: WorkWindowResumeRequest,
): WorkWindowResumeDecision {
  // 手动取消优先于一切：睡眠/唤醒不得复活
  if (request.isManuallyCancelled) {
    return {
      kind: "suppressed-by-manual-cancel",
      reason: "用户已手动取消：睡眠唤醒也不会恢复（需要时请重新发起）。",
    };
  }
  if (request.currentState === "resting") {
    return {
      kind: "no-new-business-calls",
      reason: "仍在休息时段：不恢复任何业务调用，也不产生模型请求。",
    };
  }
  if (!request.hasPendingResume) {
    return { kind: "nothing-pending", reason: "没有待恢复的业务：无需动作。" };
  }
  if (request.hasResumedSinceWake) {
    return {
      kind: "already-resumed",
      reason: "本次唤醒已经恢复过一次：不重复恢复（避免同一任务跑两遍）。",
    };
  }
  if (request.previousState === "working") {
    // 状态没变过（例如短暂抖动）也不重复恢复
    return {
      kind: "nothing-pending",
      reason: "状态未发生 rest→working 变化：不触发恢复。",
    };
  }
  return { kind: "resume-once", reason: "从休息进入工作时段：恢复一次待恢复业务。" };
}

/** 停止能力（"无法停止如实显示"）。 */
export type WorkWindowStopCapability =
  | { readonly kind: "stopped"; readonly didStop: true; readonly reason: string }
  | { readonly kind: "not-requested"; readonly didStop: false; readonly reason: string }
  | {
      readonly kind: "stop-unresponsive";
      readonly didStop: false;
      readonly reason: string;
      /** UI 必须显示"未停止"，不得显示"已停止"。 */
      readonly isHonestNotStopped: true;
    };

/**
 * 描述停止结果：**超时未停就说没停**。
 *
 * `isStopConfirmed` 只有调用方**真正确认**（进程/任务已退出）时才可为 true。
 */
export function describeWorkWindowStopCapability(input: {
  readonly isStopRequested: boolean;
  readonly isStopConfirmed: boolean;
  readonly elapsedMilliseconds: number;
  readonly timeoutMilliseconds: number;
}): WorkWindowStopCapability {
  if (!input.isStopRequested) {
    return { kind: "not-requested", didStop: false, reason: "尚未请求停止。" };
  }
  if (input.isStopConfirmed) {
    return { kind: "stopped", didStop: true, reason: "已确认停止。" };
  }
  if (input.elapsedMilliseconds >= input.timeoutMilliseconds) {
    return {
      kind: "stop-unresponsive",
      didStop: false,
      reason:
        "停止请求已超时（" +
        String(input.elapsedMilliseconds) +
        "ms ≥ " +
        String(input.timeoutMilliseconds) +
        "ms）且未获确认：仍未停止，请勿显示为已停止。",
      isHonestNotStopped: true,
    };
  }
  return {
    kind: "stop-unresponsive",
    didStop: false,
    reason: "停止请求已发出但未确认：仍在进行中，不要显示为已停止。",
    isHonestNotStopped: true,
  };
}

/** 设置视图（对话/设置入口用；只展示，不在这里改规则）。 */
export interface WorkWindowSettingsView {
  readonly ruleRows: ReadonlyArray<{
    readonly ruleIdentifier: string;
    readonly weekdayDisplay: string;
    readonly timeRangeDisplay: string;
    readonly timeZoneDisplay: string;
    readonly priorityDisplay: string;
  }>;
  readonly pausedDisplay: string;
  readonly activePauseReasonDisplay: ReadonlyArray<string>;
  readonly emptyReasonDisplay: string | null;
}

function weekdayDisplayOf(weekdays: ReadonlyArray<number>): string {
  if (weekdays.length === 0) return "未限定星期";
  const names = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return weekdays
    .map((weekday) => names[weekday - 1] ?? "未知星期(" + String(weekday) + ")")
    .join("、");
}

function minuteToClock(minuteOfDay: number): string {
  if (!Number.isFinite(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1440) {
    return "未知时间(" + String(minuteOfDay) + ")";
  }
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
}

/** 构建设置视图（纯函数；未知取值如实显示"未知"，不猜）。 */
export function buildWorkWindowSettingsView(input: {
  readonly rules: ReadonlyArray<WorkWindowRule>;
  readonly activePauseReasonKinds: ReadonlyArray<string>;
}): WorkWindowSettingsView {
  const ruleRows = input.rules.map((rule) => ({
    ruleIdentifier: rule.ruleIdentifier,
    weekdayDisplay: weekdayDisplayOf(rule.weekdays),
    timeRangeDisplay:
      minuteToClock(rule.startMinuteOfDay) + "–" + minuteToClock(rule.endMinuteOfDay),
    timeZoneDisplay: rule.timeZone,
    priorityDisplay: rule.priority === "one-off" ? "一次性例外" : "周期规则",
  }));

  return {
    ruleRows,
    pausedDisplay:
      input.activePauseReasonKinds.length === 0
        ? "未暂停"
        : "已暂停：" + input.activePauseReasonKinds.join("、"),
    activePauseReasonDisplay: [...input.activePauseReasonKinds],
    emptyReasonDisplay:
      ruleRows.length === 0
        ? "没有时段规则：按既有契约默认全天可工作（这不是“已暂停”）。"
        : null,
  };
}
