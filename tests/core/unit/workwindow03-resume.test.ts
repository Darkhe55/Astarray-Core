/**
 * WORKWINDOW-01-03 反例（2026-10-20）：睡眠后只恢复一次、休息期不发新请求、
 * 手动取消不复活、无法停止如实显示、设置视图未知值不猜。
 */
import { describe, expect, it } from "vitest";

import {
  buildWorkWindowSettingsView,
  describeWorkWindowStopCapability,
  evaluateWorkWindowResume,
} from "../../../packages/core/src/orchestration/work-window-resume.js";
import type { WorkWindowRule } from "../../../packages/core/src/orchestration/work-window-contract.js";

const rule: WorkWindowRule = {
  ruleIdentifier: "rule-work",
  mode: "work-whitelist",
  weekdays: [1, 2, 3],
  startMinuteOfDay: 9 * 60,
  endMinuteOfDay: 18 * 60,
  timeZone: "UTC",
  priority: "periodic",
  validFromUtcIso: null,
  validUntilUtcIso: null,
  scopeKind: "global",
};

function resume(overrides: Partial<Parameters<typeof evaluateWorkWindowResume>[0]> = {}) {
  return evaluateWorkWindowResume({
    previousState: "resting",
    currentState: "working",
    hasPendingResume: true,
    isManuallyCancelled: false,
    hasResumedSinceWake: false,
    ...overrides,
  });
}

describe("WORKWINDOW-01-03 恢复与停止", () => {
  it("① 睡眠后休息→工作 ⇒ 恢复一次", () => {
    expect(resume().kind).toBe("resume-once");
  });

  it("② 同一唤醒内第二次调用 ⇒ already-resumed（不重复跑）", () => {
    const decision = resume({ hasResumedSinceWake: true });
    expect(decision.kind).toBe("already-resumed");
    expect(decision.reason).toContain("不重复");
  });

  it("③ 手动取消 ⇒ 唤醒也不复活（取消优先）", () => {
    const decision = resume({ isManuallyCancelled: true });
    expect(decision.kind).toBe("suppressed-by-manual-cancel");
  });

  it("④ 仍在休息 ⇒ 不恢复任何业务调用", () => {
    const decision = resume({ currentState: "resting" });
    expect(decision.kind).toBe("no-new-business-calls");
  });

  it("⑤ 没有待恢复业务 ⇒ nothing-pending（不制造恢复动作）", () => {
    expect(resume({ hasPendingResume: false }).kind).toBe("nothing-pending");
  });

  it("⑥ 状态未变化（working→working）⇒ 不触发恢复", () => {
    expect(resume({ previousState: "working" }).kind).toBe("nothing-pending");
  });

  it("⑦ 停止未请求 ⇒ not-requested（不显示已停）", () => {
    const capability = describeWorkWindowStopCapability({
      isStopRequested: false,
      isStopConfirmed: false,
      elapsedMilliseconds: 0,
      timeoutMilliseconds: 1000,
    });
    expect(capability).toMatchObject({ kind: "not-requested", didStop: false });
  });

  it("⑧ 停止已确认 ⇒ stopped", () => {
    const capability = describeWorkWindowStopCapability({
      isStopRequested: true,
      isStopConfirmed: true,
      elapsedMilliseconds: 10,
      timeoutMilliseconds: 1000,
    });
    expect(capability).toMatchObject({ kind: "stopped", didStop: true });
  });

  it("⑨ 停止超时未确认 ⇒ stop-unresponsive 且声明未停止（最关键的一条）", () => {
    const capability = describeWorkWindowStopCapability({
      isStopRequested: true,
      isStopConfirmed: false,
      elapsedMilliseconds: 5000,
      timeoutMilliseconds: 1000,
    });
    expect(capability).toMatchObject({
      kind: "stop-unresponsive",
      didStop: false,
      isHonestNotStopped: true,
    });
    expect(capability.reason).toContain("未获确认");
  });

  it("⑩ 停止请求中未超时也**不得**显示已停止", () => {
    const capability = describeWorkWindowStopCapability({
      isStopRequested: true,
      isStopConfirmed: false,
      elapsedMilliseconds: 100,
      timeoutMilliseconds: 1000,
    });
    expect(capability.didStop).toBe(false);
    expect(capability.kind).toBe("stop-unresponsive");
  });

  it("⑪ 设置视图：规则行含星期/时间/时区/优先级，可读", () => {
    const view = buildWorkWindowSettingsView({ rules: [rule], activePauseReasonKinds: [] });
    expect(view.ruleRows[0]).toMatchObject({
      weekdayDisplay: "周一、周二、周三",
      timeRangeDisplay: "09:00–18:00",
      timeZoneDisplay: "UTC",
      priorityDisplay: "周期规则",
    });
    expect(view.pausedDisplay).toBe("未暂停");
    expect(view.emptyReasonDisplay).toBeNull();
  });

  it("⑫ 设置视图：无规则时说清是「默认全天可工作」而不是「已暂停」", () => {
    const view = buildWorkWindowSettingsView({ rules: [], activePauseReasonKinds: [] });
    expect(view.emptyReasonDisplay).toContain("默认全天可工作");
  });

  it("⑬ 设置视图：暂停原因全部列出（不折叠）", () => {
    const view = buildWorkWindowSettingsView({
      rules: [rule],
      activePauseReasonKinds: ["user-paused", "watchdog"],
    });
    expect(view.activePauseReasonDisplay).toEqual(["user-paused", "watchdog"]);
    expect(view.pausedDisplay).toContain("user-paused");
    expect(view.pausedDisplay).toContain("watchdog");
  });
});

