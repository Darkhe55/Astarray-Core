/**
 * ONBOARD-01-01 的反例（2026-10-19 R24）：首次/适时提示的触发、冷却与拒绝状态。
 *
 * 卡内验收：跳过、不再提示、重启及迁移不反复弹出；不抢焦点、不隐式授权。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ONBOARDING_HINT_INTERVAL_DAYS,
  FIRST_ONBOARDING_HINT_TEXT,
  applyOnboardingHintOutcome,
  createOnboardingHintState,
  describeOnboardingMetadataBoundary,
  evaluateOnboardingHint,
  evaluateRecommendationConsent,
} from "../../../packages/core/src/orchestration/onboarding-hint-contract.js";

const idleContext = {
  isUserTyping: false,
  isAuthorizationPending: false,
  isErrorRecovery: false,
  isEmergencyActive: false,
  isHighLoad: false,
};

const noSignal = {
  hasCompletedMilestone: false,
  hasAskedAboutEfficiency: false,
  hasDuplicateWorkDetected: false,
};

describe("ONBOARD-01-01：提示触发、冷却与拒绝", () => {
  it("① 首次使用 ⇒ 显示首次提示（文案逐字来自卡内）", () => {
    const decision = evaluateOnboardingHint({
      nowIso: "2026-10-19T00:00:00.000Z",
      state: createOnboardingHintState(),
      context: idleContext,
      triggerSignals: noSignal,
    });
    expect(decision.kind).toBe("show-first");
    if (decision.kind !== "show-first") throw new Error("应显示首次");
    expect(decision.text).toBe(FIRST_ONBOARDING_HINT_TEXT);
  });

  it("② 「不再提示」持久化生效，换文案也不能绕过", () => {
    const state = applyOnboardingHintOutcome({
      state: createOnboardingHintState(),
      outcome: "never-show-again",
      atIso: "2026-10-19T00:00:00.000Z",
    });
    expect(state.isNeverShowAgain).toBe(true);
    const later = evaluateOnboardingHint({
      nowIso: "2027-01-01T00:00:00.000Z",
      state,
      context: idleContext,
      triggerSignals: { hasCompletedMilestone: true, hasAskedAboutEfficiency: true, hasDuplicateWorkDetected: true },
    });
    expect(later).toMatchObject({ kind: "suppress", reasonCode: "never-show-again" });
  });

  it("③ 跳过之后不会反复弹首次提示", () => {
    const skipped = applyOnboardingHintOutcome({
      state: createOnboardingHintState(),
      outcome: "skipped",
      atIso: "2026-10-19T00:00:00.000Z",
    });
    const decision = evaluateOnboardingHint({
      nowIso: "2026-10-19T01:00:00.000Z",
      state: skipped,
      context: idleContext,
      triggerSignals: noSignal,
    });
    // 已看过首提示 ⇒ 走冷却/信号判定，而不是再次 show-first
    expect(decision.kind).not.toBe("show-first");
  });

  it("④ 忙碌类上下文全部抑制（输入/授权/错误/紧急/高负载）", () => {
    const state = createOnboardingHintState();
    for (const context of [
      { ...idleContext, isUserTyping: true },
      { ...idleContext, isAuthorizationPending: true },
      { ...idleContext, isErrorRecovery: true },
      { ...idleContext, isEmergencyActive: true },
      { ...idleContext, isHighLoad: true },
    ]) {
      expect(
        evaluateOnboardingHint({
          nowIso: "2026-10-19T00:00:00.000Z",
          state,
          context,
          triggerSignals: { hasCompletedMilestone: true, hasAskedAboutEfficiency: false, hasDuplicateWorkDetected: false },
        }).kind,
      ).toBe("suppress");
    }
  });

  it("⑤ 迁移后状态缺失 ⇒ 不重复弹首次（保留手动入口）", () => {
    expect(
      evaluateOnboardingHint({
        nowIso: "2026-10-19T00:00:00.000Z",
        state: createOnboardingHintState(),
        context: idleContext,
        triggerSignals: noSignal,
        isStateUnknownAfterMigration: true,
      }),
    ).toMatchObject({ kind: "suppress", reasonCode: "state-unknown-after-migration" });
  });

  it("⑥ 冷却：默认 7 天内不再提示；超过后需本地信号才提示", () => {
    const shown = applyOnboardingHintOutcome({
      state: createOnboardingHintState(),
      outcome: "shown",
      atIso: "2026-10-19T00:00:00.000Z",
    });
    expect(DEFAULT_ONBOARDING_HINT_INTERVAL_DAYS).toBe(7);

    expect(
      evaluateOnboardingHint({
        nowIso: "2026-10-24T00:00:00.000Z",
        state: shown,
        context: idleContext,
        triggerSignals: { hasCompletedMilestone: true, hasAskedAboutEfficiency: false, hasDuplicateWorkDetected: false },
      }),
    ).toMatchObject({ kind: "suppress", reasonCode: "cooldown" });

    // 超过 7 天但**没有**本地信号 ⇒ 仍不打扰
    expect(
      evaluateOnboardingHint({
        nowIso: "2026-10-26T00:00:00.000Z",
        state: shown,
        context: idleContext,
        triggerSignals: noSignal,
      }),
    ).toMatchObject({ kind: "suppress", reasonCode: "no-trigger-signal" });

    expect(
      evaluateOnboardingHint({
        nowIso: "2026-10-26T00:00:00.000Z",
        state: shown,
        context: idleContext,
        triggerSignals: { hasCompletedMilestone: false, hasAskedAboutEfficiency: true, hasDuplicateWorkDetected: false },
      }).kind,
    ).toBe("show-periodic");
  });

  it("⑦ 推荐不构成授权：仍需另走任务与授权流程", () => {
    expect(evaluateRecommendationConsent({ hasUserChosenToProceed: true })).toMatchObject({
      impliesAuthorization: false,
      requiresSeparateAuthorizationFlow: true,
      isExecutableNow: false,
    });
    expect(evaluateRecommendationConsent({ hasUserChosenToProceed: false }).reason).toContain(
      "不执行",
    );
  });

  it("⑧ 元数据边界：不上传遥测、不做画像、不为推荐读取项目", () => {
    expect(describeOnboardingMetadataBoundary()).toEqual({
      uploadedTelemetryFields: [],
      storesProfile: false,
      readsProjectsForRecommendation: false,
    });
  });
});
