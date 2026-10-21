/**
 * SECRETARY-01-04 / ONBOARD-01-02 反例（2026-10-21）。
 *
 * 覆盖：启动不阻塞对话、预算有界、工作时段、证据可追溯、两种习惯、入口不抢焦点/不隐式授权、
 * 显式执行需确认、默认值待确认提示。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SECRETARY_BUDGET,
  DEFAULT_SECRETARY_WORK_WINDOW,
  SECRETARY_HABITS,
  ONBOARDING_SURFACES,
  buildSecretaryReportEntry,
  describeSecretaryDefaultsForConfirmation,
  evaluateExplicitExecution,
  evaluateOnboardingEntry,
  evaluateSecretaryBudget,
  evaluateSecretaryStartup,
  evaluateSecretaryWorkWindow,
} from "../../../packages/core/src/orchestration/secretary-policy.js";

describe("SECRETARY-01-04 默认值/启动/预算/工作时段", () => {
  it("① 项目对话忙碌 ⇒ 两种习惯都**不启动整理**（不阻塞对话）", () => {
    for (const habit of SECRETARY_HABITS) {
      const decision = evaluateSecretaryStartup({ habit, isProjectConversationBusy: true });
      expect(decision.kind).toBe("deferred");
      expect(decision.reason).toContain("不阻塞");
    }
  });

  it("② 项目对话空闲 ⇒ 可以开始", () => {
    expect(evaluateSecretaryStartup({ habit: "project-first", isProjectConversationBusy: false }).kind).toBe("start");
  });

  it("③ 预算耗尽 ⇒ exhausted 且剩余为 0（不无限重试）", () => {
    const verdict = evaluateSecretaryBudget({ tokensUsed: DEFAULT_SECRETARY_BUDGET.sessionTokenLimit });
    expect(verdict).toMatchObject({ kind: "exhausted", remainingTokenCount: 0 });
    expect(verdict.kind === "exhausted" ? verdict.reason : "").toContain("不无限重试");
  });

  it("④ 预算内 ⇒ within，剩余可算", () => {
    expect(evaluateSecretaryBudget({ tokensUsed: 5_000 })).toEqual({
      kind: "within",
      remainingTokenCount: DEFAULT_SECRETARY_BUDGET.sessionTokenLimit - 5_000,
    });
  });

  it("⑤ 工作时段内/外判定（默认 09:00–18:00）", () => {
    expect(evaluateSecretaryWorkWindow({ minuteOfDay: 10 * 60 }).kind).toBe("inside");
    expect(evaluateSecretaryWorkWindow({ minuteOfDay: 8 * 60 }).kind).toBe("outside");
    expect(evaluateSecretaryWorkWindow({ minuteOfDay: 18 * 60 }).kind).toBe("outside");
    expect(DEFAULT_SECRETARY_WORK_WINDOW.isDefaultPendingUserConfirmation).toBe(true);
  });

  it("⑥ 非法时间 ⇒ 按不工作处理（不猜）", () => {
    const verdict = evaluateSecretaryWorkWindow({ minuteOfDay: Number.NaN });
    expect(verdict.kind).toBe("outside");
    expect(verdict.reason).toContain("不猜");
  });

  it("⑦ 报告条目必须有证据引用（无证据 ⇒ 拒绝）", () => {
    const outcome = buildSecretaryReportEntry({
      entryIdentifier: "entry-1",
      summaryText: "整理完成",
      projectIdentifier: "project-a",
      evidenceReferences: ["   "],
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "missing-evidence" });
  });

  it("⑧ 缺项目标识 ⇒ 拒绝（无法归属证据）", () => {
    const outcome = buildSecretaryReportEntry({
      entryIdentifier: "entry-1",
      summaryText: "整理完成",
      projectIdentifier: " ",
      evidenceReferences: ["mission#1"],
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "missing-project" });
  });

  it("⑨ 有项目 + 证据 ⇒ accepted，且空白引用被过滤", () => {
    const outcome = buildSecretaryReportEntry({
      entryIdentifier: "entry-1",
      summaryText: "整理完成",
      projectIdentifier: "project-a",
      evidenceReferences: ["mission#1", "  "],
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") throw new Error("unreachable");
    expect(outcome.entry.evidenceReferences).toEqual(["mission#1"]);
  });

  it("⑩ 默认值展示里**三条都标注待确认**", () => {
    const lines = describeSecretaryDefaultsForConfirmation();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((line) => line.includes("待确认"))).toBe(true);
  });
});

describe("ONBOARD-01-02 入口与显式执行", () => {
  it("⑪ 两个界面都能展示入口，且**不抢焦点/不隐式授权**", () => {
    for (const surface of ONBOARDING_SURFACES) {
      const decision = evaluateOnboardingEntry({ surface, isBusy: false });
      expect(decision).toMatchObject({ kind: "show", surface, doesStealFocus: false, impliesAuthorization: false });
    }
  });

  it("⑫ 忙碌时抑制入口（避免抢焦点）", () => {
    const decision = evaluateOnboardingEntry({ surface: "project", isBusy: true });
    expect(decision.kind).toBe("suppressed");
  });

  it("⑬ 未确认 ⇒ await-confirmation（文案说明确认后才执行）", () => {
    const decision = evaluateExplicitExecution({ isUserConfirmed: false, planSummaryText: "整理 3 个项目" });
    expect(decision.kind).toBe("await-confirmation");
    expect(decision.confirmationText).toContain("确认后才执行");
  });

  it("⑭ 已确认 ⇒ execute", () => {
    const decision = evaluateExplicitExecution({ isUserConfirmed: true, planSummaryText: "整理 3 个项目" });
    expect(decision.kind).toBe("execute");
  });
});
