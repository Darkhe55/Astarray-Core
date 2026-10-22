/**
 * SECRETARY-01-04 / ONBOARD-01-02 反例（2026-10-21）。
 *
 * 覆盖：启动不阻塞对话、预算有界、工作时段、证据可追溯、两种习惯、入口不抢焦点/不隐式授权、
 * 显式执行需确认、默认值待确认提示。
 */
import { describe, expect, it } from "vitest";

import {
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

  it("③ 默认不限预算 ⇒ 始终 within（用户 2026-10-22 决定）", () => {
    const verdict = evaluateSecretaryBudget({ tokensUsed: 10_000_000 });
    expect(verdict.kind).toBe("within");
  });

  it("④ 显式配置预算时才按上限判定", () => {
    expect(evaluateSecretaryBudget({ tokensUsed: 5_000, sessionTokenLimit: 20_000 })).toEqual({
      kind: "within",
      remainingTokenCount: 15_000,
    });
    const exhausted = evaluateSecretaryBudget({ tokensUsed: 20_000, sessionTokenLimit: 20_000 });
    expect(exhausted).toMatchObject({ kind: "exhausted", remainingTokenCount: 0 });
    expect(exhausted.kind === "exhausted" ? exhausted.reason : "").toContain("不无限重试");
  });

  it("⑤ 默认工作时段为**全天**（用户 2026-10-22 决定）", () => {
    expect(evaluateSecretaryWorkWindow({ minuteOfDay: 10 * 60 }).kind).toBe("inside");
    expect(evaluateSecretaryWorkWindow({ minuteOfDay: 3 * 60 }).kind).toBe("inside");
    expect(evaluateSecretaryWorkWindow({ minuteOfDay: 23 * 60 + 59 }).kind).toBe("inside");
    expect(DEFAULT_SECRETARY_WORK_WINDOW.startMinuteOfDay).toBe(0);
    expect(DEFAULT_SECRETARY_WORK_WINDOW.endMinuteOfDay).toBe(24 * 60);
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

  it("⑩ 默认值展示写明用户决定（预算不限、全天）", () => {
    const lines = describeSecretaryDefaultsForConfirmation();
    expect(lines.some((line) => line.includes("默认不限"))).toBe(true);
    expect(lines.some((line) => line.includes("默认全天"))).toBe(true);
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
