/**
 * EXPLORE-01-01 的反例（2026-10-18 R11）：问题指纹、计划与独立预算/触发/停止契约。
 *
 * 卡内验收：资源未知、禁用、权限不足不能启动；预算持久化扣减、不透支；
 * 无进展/预算/撤销/休息/工具失败/环境异常必须停止且不自发续预算。
 */
import { describe, expect, it } from "vitest";

import {
  applyExplorationBudgetConsumption,
  assessExplorationPlan,
  computeExplorationProblemFingerprint,
  evaluateExplorationStart,
  evaluateExplorationStop,
  type ExplorationBudget,
  type ExplorationPlanInput,
} from "../../../packages/core/src/orchestration/explore-plan-contract.js";

const budget: ExplorationBudget = {
  wallClockMinutes: 60,
  modelRequests: 20,
  tokens: 40_000,
  maximumTrials: 10,
  concurrency: 2,
  estimatedCostAmount: 1.5,
};

function plan(overrides: Partial<ExplorationPlanInput> = {}): ExplorationPlanInput {
  return {
    problemDescription: "构建在 Windows 上偶发超时",
    triedApproaches: ["重跑", "降低并发"],
    hypothesesToVerify: ["超时来自子进程未收口"],
    candidateDirections: ["换成进程组收口", "加超时预算"],
    dataAndToolScope: "仅隔离测试目录与假服务",
    stopConditions: ["连续 2 轮无进展", "预算耗尽"],
    budget,
    parameterCombinationIdentifier: "windows-timeout-v1",
    versionIdentifier: "abc123",
    ...overrides,
  };
}

describe("EXPLORE-01-01：问题指纹、计划与预算/触发/停止契约", () => {
  it("① 指纹只看问题+证据+版本：证据顺序无关、版本变则变", () => {
    const first = computeExplorationProblemFingerprint({
      problemSignature: "windows timeout",
      failureEvidenceIdentifiers: ["log-b", "log-a", "log-a"],
      versionIdentifier: "abc123",
    });
    const reordered = computeExplorationProblemFingerprint({
      problemSignature: "windows timeout",
      failureEvidenceIdentifiers: ["log-a", "log-b"],
      versionIdentifier: "abc123",
    });
    expect(first).toBe(reordered);
    const otherVersion = computeExplorationProblemFingerprint({
      problemSignature: "windows timeout",
      failureEvidenceIdentifiers: ["log-a", "log-b"],
      versionIdentifier: "def456",
    });
    expect(otherVersion).not.toBe(first);
  });

  it("② 计划缺已试方法/假设/停止条件 ⇒ 拒绝（不允许无界探索）", () => {
    expect(assessExplorationPlan(plan({ triedApproaches: [] })).kind).toBe("rejected");
    expect(assessExplorationPlan(plan({ hypothesesToVerify: [] })).kind).toBe("rejected");
    const noStop = assessExplorationPlan(plan({ stopConditions: [] }));
    expect(noStop.kind).toBe("rejected");
    if (noStop.kind !== "rejected") throw new Error("应拒绝");
    expect(noStop.reasonCode).toBe("no-stop-conditions");
  });

  it("③ 预算非法（0/负数/缺维度）⇒ 拒绝", () => {
    const rejected = assessExplorationPlan(
      plan({ budget: { ...budget, wallClockMinutes: 0 } }),
    );
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind !== "rejected") throw new Error("应拒绝");
    expect(rejected.reasonCode).toBe("invalid-budget");
  });

  it("④ 完整计划 ⇒ accepted 且给出指纹", () => {
    const accepted = assessExplorationPlan(plan());
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("应接受");
    expect(accepted.fingerprint).toHaveLength(64);
  });

  it("⑤ 启动：默认关闭 / 范围未授权 / 资源未知且无本地预算 ⇒ 都不能启动", () => {
    const baseline = {
      isExperimentEnabled: true,
      isCurrentScopeAuthorizedByUser: true,
      isResourceStateUnknown: false,
      hasUserApprovedLocalBudget: false,
      budget,
      sessionConcurrencyLimit: 4,
      exploredCombinationFingerprints: [],
      targetCombinationFingerprint: "combo-1",
    };
    expect(evaluateExplorationStart({ ...baseline, isExperimentEnabled: undefined })).toMatchObject({
      kind: "no-start",
      reasonCode: "disabled",
    });
    expect(
      evaluateExplorationStart({ ...baseline, isCurrentScopeAuthorizedByUser: false }),
    ).toMatchObject({ kind: "no-start", reasonCode: "scope-not-authorized" });
    expect(
      evaluateExplorationStart({
        ...baseline,
        isResourceStateUnknown: true,
        hasUserApprovedLocalBudget: false,
      }),
    ).toMatchObject({ kind: "no-start", reasonCode: "resource-unknown" });
    // 资源未知但**有用户批准的本地预算** ⇒ 允许
    expect(
      evaluateExplorationStart({
        ...baseline,
        isResourceStateUnknown: true,
        hasUserApprovedLocalBudget: true,
      }).kind,
    ).toBe("start");
  });

  it("⑥ 启动：相同参数+版本组合不重复探索；并发超限不启动", () => {
    const baseline = {
      isExperimentEnabled: true,
      isCurrentScopeAuthorizedByUser: true,
      isResourceStateUnknown: false,
      hasUserApprovedLocalBudget: true,
      budget,
      sessionConcurrencyLimit: 4,
      exploredCombinationFingerprints: ["combo-1"],
      targetCombinationFingerprint: "combo-1",
    };
    expect(evaluateExplorationStart(baseline)).toMatchObject({
      kind: "no-start",
      reasonCode: "duplicate-combination",
    });
    expect(
      evaluateExplorationStart({
        ...baseline,
        exploredCombinationFingerprints: [],
        sessionConcurrencyLimit: 1,
      }),
    ).toMatchObject({ kind: "no-start", reasonCode: "concurrency-exceeds-session-limit" });
  });

  it("⑦ 启动成功时：低于用户任务优先级，且不能自行续预算", () => {
    const decision = evaluateExplorationStart({
      isExperimentEnabled: true,
      isCurrentScopeAuthorizedByUser: true,
      isResourceStateUnknown: false,
      hasUserApprovedLocalBudget: true,
      budget,
      sessionConcurrencyLimit: 4,
      exploredCombinationFingerprints: [],
      targetCombinationFingerprint: "combo-new",
    });
    expect(decision.kind).toBe("start");
    if (decision.kind !== "start") throw new Error("应启动");
    expect(decision.isPriorityBelowUserTasks).toBe(true);
    expect(decision.canSelfRenewBudget).toBe(false);
  });

  it("⑧ 预算扣减：足够则逐维扣减；任一维不足 ⇒ exhausted 且**不扣减**（不透支）", () => {
    const consumed = applyExplorationBudgetConsumption({
      budget,
      consumed: { wallClockMinutes: 10, modelRequests: 3, tokens: 5_000, trials: 2 },
    });
    expect(consumed.kind).toBe("consumed");
    if (consumed.kind !== "consumed") throw new Error("应扣减");
    expect(consumed.remaining.wallClockMinutes).toBe(50);
    expect(consumed.remaining.maximumTrials).toBe(8);

    const exhausted = applyExplorationBudgetConsumption({
      budget,
      consumed: { wallClockMinutes: 10, modelRequests: 3, tokens: 5_000, trials: 99 },
    });
    expect(exhausted.kind).toBe("exhausted");
    if (exhausted.kind !== "exhausted") throw new Error("应耗尽");
    expect(exhausted.remaining).toEqual(budget);
  });

  it("⑨ 停止条件：撤销/休息/预算/环境/工具失败/无进展 逐条命中，且都不自行续预算", () => {
    const base = {
      consecutiveNoProgressRounds: 0,
      maximumNoProgressRounds: 3,
      isBudgetReached: false,
      isUserCancelled: false,
      isRestPeriod: false,
      consecutiveToolFailureCount: 0,
      maximumToolFailureCount: 3,
      isEnvironmentAbnormal: false,
    };
    expect(evaluateExplorationStop({ ...base, isUserCancelled: true })).toMatchObject({
      kind: "stop",
      reasonCode: "user-cancelled",
      canSelfRenewBudget: false,
    });
    expect(evaluateExplorationStop({ ...base, isRestPeriod: true })).toMatchObject({
      reasonCode: "rest-period",
    });
    expect(evaluateExplorationStop({ ...base, isBudgetReached: true })).toMatchObject({
      reasonCode: "budget-reached",
    });
    expect(evaluateExplorationStop({ ...base, isEnvironmentAbnormal: true })).toMatchObject({
      reasonCode: "environment-abnormal",
    });
    expect(evaluateExplorationStop({ ...base, consecutiveToolFailureCount: 3 })).toMatchObject({
      reasonCode: "tool-failures",
    });
    expect(evaluateExplorationStop({ ...base, consecutiveNoProgressRounds: 3 })).toMatchObject({
      reasonCode: "no-progress",
    });
    expect(evaluateExplorationStop(base)).toMatchObject({ kind: "continue" });
  });
});
