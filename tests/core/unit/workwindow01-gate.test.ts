/**
 * WORKWINDOW-01-02 统一门禁反例（2026-10-20）。
 *
 * 卡内点名：长工具、独立反馈、watchdog、权限到期、**多个暂停原因不互相覆盖**，以及三处门禁一致。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateWorkWindowGate,
  mergePauseReasons,
  readActivePauseReasonKinds,
} from "../../../packages/core/src/orchestration/work-window-gate.js";
import {
  createPauseReasonState,
  evaluateWorkWindowState,
  type WorkWindowRule,
} from "../../../packages/core/src/orchestration/work-window-contract.js";

/** 周一 09:00–18:00 允许（UTC 时区避免本机时区影响）。 */
const workingRule: WorkWindowRule = {
  ruleIdentifier: "rule-work",
  mode: "work-whitelist",
  weekdays: [1, 2, 3, 4, 5],
  startMinuteOfDay: 9 * 60,
  endMinuteOfDay: 18 * 60,
  timeZone: "UTC",
  priority: "periodic",
  validFromUtcIso: null,
  validUntilUtcIso: null,
  scopeKind: "global",
};

// 2026-10-19 是周一
const insideWorkingHours = "2026-10-19T10:00:00.000Z";
const outsideWorkingHours = "2026-10-19T22:00:00.000Z";

function gateRequest(overrides: Record<string, unknown> = {}) {
  return {
    gatePoint: "dispatch" as const,
    nowIso: insideWorkingHours,
    rules: [workingRule],
    pauseReasonState: createPauseReasonState(),
    ...overrides,
  };
}

describe("WORKWINDOW-01-02 统一门禁", () => {
  it("① 工作时段且无暂停 ⇒ 三处门禁点都放行", () => {
    for (const gatePoint of ["dispatch", "model", "tool-execution"] as const) {
      const decision = evaluateWorkWindowGate(gateRequest({ gatePoint }));
      expect(decision.kind).toBe("allow");
    }
  });

  it("② 休息时段 ⇒ 三处门禁点都拒绝（不允许某处漏判）", () => {
    for (const gatePoint of ["dispatch", "model", "tool-execution"] as const) {
      const decision = evaluateWorkWindowGate(gateRequest({ gatePoint, nowIso: outsideWorkingHours }));
      expect(decision).toMatchObject({ kind: "deny", reasonCode: "resting" });
    }
  });

  it("③ 独立反馈在休息期间放行，且明确不产生模型/业务请求", () => {
    const decision = evaluateWorkWindowGate(
      gateRequest({ nowIso: outsideWorkingHours, isIndependentFeedback: true }),
    );
    expect(decision).toMatchObject({
      kind: "allow",
      doesProduceModelOrBusinessRequest: false,
    });
  });

  it("④ 已在执行的长工具允许收尾（休息期间也不被拦）", () => {
    const decision = evaluateWorkWindowGate(
      gateRequest({ nowIso: outsideWorkingHours, isLongRunningContinuation: true }),
    );
    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") {
      expect(decision.reason).toContain("不得");
    }
  });

  it("⑤ 暂停原因存在 ⇒ 拒绝并列出**全部**原因（不覆盖）", () => {
    const state = mergePauseReasons({
      state: createPauseReasonState(),
      addedReasonKinds: ["user-paused", "watchdog"],
    }).state;
    const decision = evaluateWorkWindowGate(gateRequest({ pauseReasonState: state }));
    expect(decision).toMatchObject({ kind: "deny", reasonCode: "paused" });
    if (decision.kind === "deny") {
      expect(decision.activePauseReasonKinds).toEqual(
        expect.arrayContaining(["user-paused", "watchdog"]),
      );
    }
  });

  it("⑥ 休息 + 暂停 ⇒ 两种原因都报（不只剩一个）", () => {
    const state = mergePauseReasons({
      state: createPauseReasonState(),
      addedReasonKinds: ["permission-expired"],
    }).state;
    const decision = evaluateWorkWindowGate(
      gateRequest({ nowIso: outsideWorkingHours, pauseReasonState: state }),
    );
    expect(decision).toMatchObject({ kind: "deny", reasonCode: "resting-and-paused", isWorkWindowResting: true });
    if (decision.kind === "deny") {
      expect(decision.activePauseReasonKinds).toContain("permission-expired");
    }
  });

  it("⑦ 合并暂停原因不清除既有原因（后来的不覆盖先前的）", () => {
    const first = mergePauseReasons({
      state: createPauseReasonState(),
      addedReasonKinds: ["user-paused"],
    });
    const second = mergePauseReasons({ state: first.state, addedReasonKinds: ["watchdog"] });
    const active = readActivePauseReasonKinds(second.state);
    expect(active).toEqual(expect.arrayContaining(["user-paused", "watchdog"]));
    expect(second.addedKinds).toEqual(["watchdog"]);
  });

  it("⑧ 重复加入同一原因 ⇒ 幂等（addedKinds 为空）", () => {
    const state = mergePauseReasons({
      state: createPauseReasonState(),
      addedReasonKinds: ["watchdog"],
    }).state;
    const again = mergePauseReasons({ state, addedReasonKinds: ["watchdog"] });
    expect(again.addedKinds).toHaveLength(0);
    expect(again.state).toBe(state);
  });

  it("⑨ 长工具收尾**不能**绕过暂停原因", () => {
    const state = mergePauseReasons({
      state: createPauseReasonState(),
      addedReasonKinds: ["permission-expired"],
    }).state;
    const decision = evaluateWorkWindowGate(
      gateRequest({ pauseReasonState: state, isLongRunningContinuation: true }),
    );
    expect(decision.kind).toBe("deny");
  });

  it("⑩ 独立反馈优先于暂停（心跳不该被静默掐断）", () => {
    const state = mergePauseReasons({
      state: createPauseReasonState(),
      addedReasonKinds: ["user-paused"],
    }).state;
    const decision = evaluateWorkWindowGate(
      gateRequest({ pauseReasonState: state, isIndependentFeedback: true }),
    );
    expect(decision).toMatchObject({ kind: "allow", doesProduceModelOrBusinessRequest: false });
  });

  it("⑪ 无规则 ⇒ 按既有契约「默认全天可工作」，并说明原因（不静默）", () => {
    const decision = evaluateWorkWindowGate(gateRequest({ rules: [] }));
    // 契约明确：未设置时段规则 ⇒ 默认全天可工作；此处只要求"放行且说明"，不改契约语义
    expect(decision.kind).toBe("allow");
    const assessment = evaluateWorkWindowState({ instantIso: insideWorkingHours, rules: [] });
    expect(assessment.reason).toContain("默认全天可工作");
  });

  it("⑫ 跨午夜规则不因日期边界误放行（22:00 属于 21:00–02:00 白名单）", () => {
    const overnightRule: WorkWindowRule = {
      ...workingRule,
      ruleIdentifier: "rule-overnight",
      startMinuteOfDay: 21 * 60,
      endMinuteOfDay: 2 * 60,
    };
    const decision = evaluateWorkWindowGate(
      gateRequest({ rules: [overnightRule], nowIso: outsideWorkingHours }),
    );
    expect(decision.kind).toBe("allow");
  });
});

