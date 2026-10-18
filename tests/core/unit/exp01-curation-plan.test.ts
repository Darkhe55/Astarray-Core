/**
 * CURATE-01-01 的反例（2026-10-18 R12）：方案预览、首次授权与重大变更矩阵。
 *
 * 卡内验收：**未授权零自动整理**；范围/Provider/预算扩大**必再询问**；
 * **模型称"小改"不能绕过本地比较**；等待只暂停新方案、旧方案可继续。
 */
import { describe, expect, it } from "vitest";

import {
  compareCurationPlans,
  computeCurationPlanFingerprint,
  evaluateCurationPlanTransition,
  evaluateCurationRun,
  type CurationAuthorizationV1,
  type CurationPlanV1,
} from "../../../packages/core/src/orchestration/curation-plan-contract.js";

function plan(overrides: Partial<CurationPlanV1> = {}): CurationPlanV1 {
  return {
    schemaVersion: 1,
    planRevision: 1,
    projectIdentifiers: ["project-a"],
    sessionIdentifiers: ["session-1"],
    agentInstanceIdentifiers: ["agent-1"],
    dataCategories: ["messages", "tool-receipts"],
    frequencyMinutes: 1_440,
    timeZone: "Asia/Shanghai",
    workWindowStartMinuteOfDay: 9 * 60,
    workWindowEndMinuteOfDay: 22 * 60,
    approvedProviderIdentifiers: ["provider-x"],
    providerIdentifier: "provider-x",
    modelIdentifier: "model-1",
    outboundContentCategories: ["messages"],
    retentionPolicy: "derived-only",
    summarizationMethodIdentifier: "sum-v1",
    classificationMethodIdentifier: "cls-v1",
    maximumMonthlyTokens: 200_000,
    isDisplayOnlyAdjustment: false,
    ...overrides,
  };
}

function authorizationFor(target: CurationPlanV1, overrides: Partial<CurationAuthorizationV1> = {}): CurationAuthorizationV1 {
  return {
    schemaVersion: 1,
    planRevision: target.planRevision,
    planFingerprint: computeCurationPlanFingerprint(target),
    approvedAtIso: "2026-10-18T00:00:00.000Z",
    isAuthenticatedUser: true,
    isRevoked: false,
    ...overrides,
  };
}

describe("CURATE-01-01：首次授权与重大变更矩阵", () => {
  it("① 未授权 ⇒ 零自动整理；非认证用户/已撤销/旧 revision/参数被改 ⇒ 全部拒绝", () => {
    const basePlan = plan();
    expect(evaluateCurationRun({ plan: basePlan, authorization: null })).toMatchObject({
      kind: "denied",
      reasonCode: "no-authorization",
    });
    expect(
      evaluateCurationRun({
        plan: basePlan,
        authorization: authorizationFor(basePlan, { isAuthenticatedUser: false }),
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "not-authenticated" });
    expect(
      evaluateCurationRun({
        plan: basePlan,
        authorization: authorizationFor(basePlan, { isRevoked: true }),
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "authorization-revoked" });
    expect(
      evaluateCurationRun({
        plan: basePlan,
        authorization: authorizationFor(basePlan, { planRevision: 0 }),
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "revision-mismatch" });

    // 批准后**改了参数**（同 revision）⇒ 指纹不符 ⇒ 拒绝
    const tamperedPlan = plan({ maximumMonthlyTokens: 500_000 });
    expect(
      evaluateCurationRun({ plan: tamperedPlan, authorization: authorizationFor(basePlan) }),
    ).toMatchObject({ kind: "denied", reasonCode: "fingerprint-mismatch" });

    expect(
      evaluateCurationRun({ plan: basePlan, authorization: authorizationFor(basePlan) }).kind,
    ).toBe("allowed");
  });

  it("② 范围扩大（新增项目/会话/个体/数据类别）⇒ 重大", () => {
    for (const overrides of [
      { projectIdentifiers: ["project-a", "project-b"] },
      { sessionIdentifiers: ["session-1", "session-2"] },
      { agentInstanceIdentifiers: ["agent-1", "agent-2"] },
      { dataCategories: ["messages", "tool-receipts", "files"] },
    ] as Array<Partial<CurationPlanV1>>) {
      const comparison = compareCurationPlans({ previous: plan(), next: plan(overrides) });
      expect(comparison.isMajor).toBe(true);
      expect(comparison.changes).toContain("scope-expanded");
    }
  });

  it("③ 换 Provider/模型、增加外发类别 ⇒ 重大", () => {
    const providerChanged = compareCurationPlans({
      previous: plan(),
      next: plan({ providerIdentifier: "provider-y" }),
    });
    expect(providerChanged.changes).toContain("provider-or-model-changed");

    const outboundAdded = compareCurationPlans({
      previous: plan(),
      next: plan({ outboundContentCategories: ["messages", "tool-receipts"] }),
    });
    expect(outboundAdded.changes).toContain("outbound-transfer-added");
  });

  it("④ 提频/加预算/扩时段/改保留策略/换方法 ⇒ 各自被本地比较认定为重大", () => {
    expect(
      compareCurationPlans({ previous: plan(), next: plan({ frequencyMinutes: 720 }) }).changes,
    ).toContain("frequency-increased");
    expect(
      compareCurationPlans({ previous: plan(), next: plan({ maximumMonthlyTokens: 400_000 }) })
        .changes,
    ).toContain("budget-increased");
    expect(
      compareCurationPlans({
        previous: plan(),
        next: plan({ workWindowStartMinuteOfDay: 7 * 60, workWindowEndMinuteOfDay: 23 * 60 }),
      }).changes,
    ).toContain("work-window-expanded");
    expect(
      compareCurationPlans({
        previous: plan(),
        next: plan({ retentionPolicy: "rewrite-or-delete" }),
      }).changes,
    ).toContain("retention-changed");
    expect(
      compareCurationPlans({
        previous: plan(),
        next: plan({ summarizationMethodIdentifier: "sum-v2" }),
      }).changes,
    ).toContain("method-changed");
  });

  it("⑤ 字段有差异但无法归类 ⇒ 按**重大**处理（模型称小改不能绕过）", () => {
    const unclassifiedChange = plan({ timeZone: "UTC" });
    const comparison = compareCurationPlans({ previous: plan(), next: unclassifiedChange });
    expect(comparison.isMajor).toBe(true);
    expect(comparison.changes).toContain("unknown-change");
    expect(comparison.reason).toContain("模型声称");
  });

  it("⑥ 纯 UI 展示调整 ⇒ 非重大，但仍留变更记录（reason 明确）", () => {
    const displayOnly = plan({ timeZone: "UTC", isDisplayOnlyAdjustment: true });
    const comparison = compareCurationPlans({ previous: plan(), next: displayOnly });
    expect(comparison.isMajor).toBe(false);
    expect(comparison.reason).toContain("小版本");
  });

  it("⑦ 重大变更未获新授权 ⇒ 只暂停新方案，旧方案仍可用（等待不打断旧方案）", () => {
    const previousPlan = plan();
    const nextPlan = plan({ planRevision: 2, maximumMonthlyTokens: 900_000 });
    const transition = evaluateCurationPlanTransition({
      previousPlan,
      nextPlan,
      nextPlanAuthorization: null,
      isUserRejected: false,
    });
    expect(transition.decision).toBe("keep-old-waiting");
    expect(transition.isNewPlanPaused).toBe(true);
    expect(transition.isOldPlanStillAllowed).toBe(true);
  });

  it("⑧ 重大变更已获新授权 ⇒ 应用新方案；用户拒绝 ⇒ 保留旧方案或停用（用户选择）", () => {
    const previousPlan = plan();
    const nextPlan = plan({ planRevision: 2, maximumMonthlyTokens: 900_000 });
    const applied = evaluateCurationPlanTransition({
      previousPlan,
      nextPlan,
      nextPlanAuthorization: authorizationFor(nextPlan),
      isUserRejected: false,
    });
    expect(applied.decision).toBe("apply-new");

    const rejected = evaluateCurationPlanTransition({
      previousPlan,
      nextPlan,
      nextPlanAuthorization: null,
      isUserRejected: true,
    });
    expect(rejected.decision).toBe("keep-old-or-disable");
    expect(rejected.userMustChoose).toBe(true);
  });

  it("⑨ 非重大变更（同方案重放）直接应用", () => {
    const previousPlan = plan();
    const transition = evaluateCurationPlanTransition({
      previousPlan,
      nextPlan: plan(),
      nextPlanAuthorization: authorizationFor(previousPlan),
      isUserRejected: false,
    });
    expect(transition.decision).toBe("apply-new");
    expect(transition.isNewPlanPaused).toBe(false);
  });
});
