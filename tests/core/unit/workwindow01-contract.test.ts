/**
 * WORKWINDOW-01-01 的反例（2026-10-18 R14）：规则、时区、作用域、暂停原因与恢复契约。
 *
 * 卡内验收：虚拟时钟覆盖**跨日、一次性例外、DST、时钟跳变**；多暂停原因不互相覆盖；
 * 用户手动暂停优先；到点不自动放行。
 */
import { describe, expect, it } from "vitest";

import {
  applyPauseReasonChange,
  computeLocalCalendarMinute,
  computeWorkWindowRulesFingerprint,
  createPauseReasonState,
  detectWallClockJump,
  evaluateResume,
  evaluateWorkWindowState,
  hasEnteredWorkingState,
  isAnyPauseReasonActive,
  isMinuteWithinRuleRange,
  listActivePauseReasons,
  type WorkWindowRule,
} from "../../../packages/core/src/orchestration/work-window-contract.js";

function rule(overrides: Partial<WorkWindowRule> = {}): WorkWindowRule {
  return {
    ruleIdentifier: "rule-1",
    mode: "rest-blacklist",
    weekdays: [],
    startMinuteOfDay: 22 * 60,
    endMinuteOfDay: 8 * 60,
    timeZone: "Asia/Shanghai",
    priority: "periodic",
    validFromUtcIso: null,
    validUntilUtcIso: null,
    scopeKind: "global",
    ...overrides,
  };
}

describe("WORKWINDOW-01-01：时段规则、时区、暂停原因与恢复", () => {
  it("① 无规则 ⇒ 全天可工作（默认）", () => {
    const assessment = evaluateWorkWindowState({
      instantIso: "2026-10-18T03:00:00.000Z",
      rules: [],
    });
    expect(assessment.state).toBe("working");
    expect(assessment.reason).toContain("全天可工作");
  });

  it("② 休息黑名单跨午夜：23:00 与 07:00 休息、12:00 工作", () => {
    const rules = [rule()];
    // 上海 = UTC+8：23:00 本地 = 15:00Z
    expect(evaluateWorkWindowState({ instantIso: "2026-10-18T15:00:00.000Z", rules }).state).toBe(
      "resting",
    );
    // 07:00 本地 = 23:00Z（前一日 UTC）
    expect(evaluateWorkWindowState({ instantIso: "2026-10-17T23:00:00.000Z", rules }).state).toBe(
      "resting",
    );
    expect(evaluateWorkWindowState({ instantIso: "2026-10-18T04:00:00.000Z", rules }).state).toBe(
      "working",
    );
  });

  it("③ 工作白名单：区间内工作、区间外休息（左闭右开）", () => {
    const rules = [
      rule({ mode: "work-whitelist", startMinuteOfDay: 9 * 60, endMinuteOfDay: 18 * 60 }),
    ];
    // 09:00 本地 = 01:00Z（左闭 ⇒ 工作）
    expect(evaluateWorkWindowState({ instantIso: "2026-10-18T01:00:00.000Z", rules }).state).toBe(
      "working",
    );
    // 18:00 本地 = 10:00Z（右开 ⇒ 休息）
    expect(evaluateWorkWindowState({ instantIso: "2026-10-18T10:00:00.000Z", rules }).state).toBe(
      "resting",
    );
    expect(evaluateWorkWindowState({ instantIso: "2026-10-18T04:00:00.000Z", rules }).state).toBe(
      "working",
    );
  });

  it("④ 一次性例外优先于周期规则（即使在周期休息区间内）", () => {
    const periodicRest = rule({
      ruleIdentifier: "periodic-rest",
      startMinuteOfDay: 12 * 60,
      endMinuteOfDay: 13 * 60,
    });
    const oneOffWork = rule({
      ruleIdentifier: "one-off-work",
      mode: "work-whitelist",
      priority: "one-off",
      startMinuteOfDay: 0,
      endMinuteOfDay: 24 * 60,
      validFromUtcIso: "2026-10-18T00:00:00.000Z",
      validUntilUtcIso: "2026-10-19T00:00:00.000Z",
    });
    // 12:30 本地 = 04:30Z，落在一次性例外有效期内
    const assessment = evaluateWorkWindowState({
      instantIso: "2026-10-18T04:30:00.000Z",
      rules: [periodicRest, oneOffWork],
    });
    expect(assessment.state).toBe("working");
    expect(assessment.matchedRuleIdentifiers).toEqual(["one-off-work"]);
  });

  it("⑤ 同优先级冲突：休息优先；项目规则不能无声覆盖全局休息", () => {
    const globalRest = rule({
      ruleIdentifier: "global-rest",
      startMinuteOfDay: 22 * 60,
      endMinuteOfDay: 8 * 60,
    });
    const projectWork = rule({
      ruleIdentifier: "project-work",
      mode: "work-whitelist",
      scopeKind: "project",
      startMinuteOfDay: 0,
      endMinuteOfDay: 24 * 60,
    });
    // 23:00 本地
    const assessment = evaluateWorkWindowState({
      instantIso: "2026-10-18T15:00:00.000Z",
      rules: [globalRest, projectWork],
    });
    expect(assessment.state).toBe("resting");
    expect(assessment.reason).toContain("休息优先");
  });

  it("⑥ 跨午夜规则的**次日凌晨**归属于前一天（周一 22:00–02:00 覆盖周二 01:00）", () => {
    const mondayNight = rule({
      weekdays: [1],
      startMinuteOfDay: 22 * 60,
      endMinuteOfDay: 2 * 60,
    });
    // 周二 01:00 本地 = 周一 17:00Z
    expect(
      isMinuteWithinRuleRange({ minuteOfDay: 60, weekday: 2, rule: mondayNight }),
    ).toBe(true);
    // 周二 03:00 不在区间
    expect(
      isMinuteWithinRuleRange({ minuteOfDay: 180, weekday: 2, rule: mondayNight }),
    ).toBe(false);
  });

  it("⑦ DST 重复小时不重复启动（America/New_York 2026-11-01）", () => {
    const allDayWork = rule({
      mode: "work-whitelist",
      timeZone: "America/New_York",
      // 本地 01:00 起开工：04:30Z（00:30 EDT）在休息、05:30Z（01:30 EDT）进入工作
      startMinuteOfDay: 60,
      endMinuteOfDay: 24 * 60,
    });
    // 05:30Z 与 06:30Z 都对应本地 01:30（重复小时）
    const first = computeLocalCalendarMinute({
      instantIso: "2026-11-01T05:30:00.000Z",
      timeZone: "America/New_York",
    });
    const second = computeLocalCalendarMinute({
      instantIso: "2026-11-01T06:30:00.000Z",
      timeZone: "America/New_York",
    });
    expect(first?.minuteOfDay).toBe(second?.minuteOfDay);
    expect(first?.localDateIso).toBe(second?.localDateIso);

    const entered = hasEnteredWorkingState({
      previousInstantIso: "2026-11-01T04:30:00.000Z",
      currentInstantIso: "2026-11-01T05:30:00.000Z",
      rules: [allDayWork],
    });
    expect(entered).toBe(true);
    const repeatedHour = hasEnteredWorkingState({
      previousInstantIso: "2026-11-01T05:30:00.000Z",
      currentInstantIso: "2026-11-01T06:30:00.000Z",
      rules: [allDayWork],
    });
    expect(repeatedHour).toBe(false);
  });

  it("⑧ 暂停原因分别记录：解除时段暂停不清除其他原因", () => {
    let state = createPauseReasonState();
    state = applyPauseReasonChange({ current: state, reason: "work-window", isPaused: true });
    state = applyPauseReasonChange({ current: state, reason: "user-paused", isPaused: true });
    expect(isAnyPauseReasonActive(state)).toBe(true);
    expect(listActivePauseReasons(state)).toEqual(["work-window", "user-paused"]);

    state = applyPauseReasonChange({ current: state, reason: "work-window", isPaused: false });
    expect(isAnyPauseReasonActive(state)).toBe(true);
    expect(listActivePauseReasons(state)).toEqual(["user-paused"]);
  });

  it("⑨ 恢复门禁：休息/暂停/用户停止/授权/租约/未知副作用逐项阻塞；全清才放行", () => {
    const clean = createPauseReasonState();
    expect(
      evaluateResume({
        windowState: "working",
        pauseReasons: clean,
        isUserStopped: false,
        isAuthorizationValid: true,
        isLeaseValid: true,
        hasUnknownSideEffects: false,
      }).isAllowed,
    ).toBe(true);

    expect(
      evaluateResume({
        windowState: "resting",
        pauseReasons: clean,
        isUserStopped: false,
        isAuthorizationValid: true,
        isLeaseValid: true,
        hasUnknownSideEffects: false,
      }).blockedReasonCodes,
    ).toContain("resting");

    const withUserPause = applyPauseReasonChange({
      current: clean,
      reason: "user-paused",
      isPaused: true,
    });
    expect(
      evaluateResume({
        windowState: "working",
        pauseReasons: withUserPause,
        isUserStopped: false,
        isAuthorizationValid: true,
        isLeaseValid: true,
        hasUnknownSideEffects: false,
      }).blockedReasonCodes,
    ).toContain("pause-reason-active");

    expect(
      evaluateResume({
        windowState: "working",
        pauseReasons: clean,
        isUserStopped: true,
        isAuthorizationValid: false,
        isLeaseValid: false,
        hasUnknownSideEffects: true,
      }).blockedReasonCodes,
    ).toEqual([
      "user-stopped",
      "authorization-invalid",
      "lease-invalid",
      "unknown-side-effects",
    ]);
  });

  it("⑩ 时钟跳变：墙钟与单调钟差异超阈值即判定跳变", () => {
    const jumped = detectWallClockJump({
      previousInstantIso: "2026-10-18T00:00:00.000Z",
      currentInstantIso: "2026-10-18T00:10:00.000Z",
      previousMonotonicMilliseconds: 0,
      currentMonotonicMilliseconds: 60_000,
    });
    expect(jumped.hasJumped).toBe(true);
    expect(jumped.wallClockDeltaMilliseconds).toBe(600_000);

    const normal = detectWallClockJump({
      previousInstantIso: "2026-10-18T00:00:00.000Z",
      currentInstantIso: "2026-10-18T00:01:00.000Z",
      previousMonotonicMilliseconds: 0,
      currentMonotonicMilliseconds: 60_000,
    });
    expect(normal.hasJumped).toBe(false);
  });

  it("⑪ 规则指纹与顺序无关、内容变化即变（用于 revision 重算）", () => {
    const first = rule({ ruleIdentifier: "a" });
    const second = rule({ ruleIdentifier: "b", startMinuteOfDay: 0, endMinuteOfDay: 60 });
    const fingerprintOne = computeWorkWindowRulesFingerprint([first, second]);
    const fingerprintTwo = computeWorkWindowRulesFingerprint([second, first]);
    expect(fingerprintOne).toBe(fingerprintTwo);
    const changed = computeWorkWindowRulesFingerprint([first, { ...second, endMinuteOfDay: 120 }]);
    expect(changed).not.toBe(fingerprintOne);
  });

  it("⑫ 非法时区 ⇒ 保守按休息（不假装可工作）", () => {
    const assessment = evaluateWorkWindowState({
      instantIso: "2026-10-18T04:00:00.000Z",
      rules: [rule({ timeZone: "Not/AZone" })],
    });
    expect(assessment.state).toBe("resting");
    expect(assessment.reason).toContain("无法解析");
  });
});
