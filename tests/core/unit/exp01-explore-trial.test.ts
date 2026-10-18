/**
 * EXPLORE-01-02 的反例（2026-10-19 R22）：有界试验执行、隔离、去重与可复现记录。
 *
 * 卡内验收：真实用户数据/生产远端禁止、隔离方式必填、并发不超限、
 * 重启预算不刷新、相同组合不重跑、阴性结果可记录。
 */
import { describe, expect, it } from "vitest";

import {
  buildExploreTrialRecord,
  computeExploreTrialKey,
  evaluateExploreTrialStart,
  restoreExploreBudgetAfterRestart,
} from "../../../packages/core/src/orchestration/explore-trial-contract.js";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    parameterCombinationIdentifier: "combo-1",
    seedIdentifier: "seed-42",
    versionIdentifier: "v1",
    isolationKind: "isolated-directory" as const,
    touchesRealUserData: false,
    touchesProductionRemote: false,
    remainingBudget: { maximumTrials: 5, tokens: 10_000 },
    activeTrialCount: 0,
    sessionConcurrencyLimit: 2,
    isUserCancelled: false,
    isRestPeriod: false,
    existingTrials: [],
    ...overrides,
  };
}

describe("EXPLORE-01-02：有界试验执行契约", () => {
  it("① 真实用户数据 / 生产远端一律禁止（即使隔离方式已声明）", () => {
    expect(evaluateExploreTrialStart(baseInput({ touchesRealUserData: true }))).toMatchObject({
      kind: "no-start",
      reasonCode: "real-user-data-forbidden",
    });
    expect(evaluateExploreTrialStart(baseInput({ touchesProductionRemote: true }))).toMatchObject({
      kind: "no-start",
      reasonCode: "production-remote-forbidden",
    });
  });

  it("② 必须声明隔离方式（隔离目录/worktree、fixture 或假服务）", () => {
    expect(evaluateExploreTrialStart(baseInput({ isolationKind: null }))).toMatchObject({
      kind: "no-start",
      reasonCode: "isolation-missing",
    });
  });

  it("③ 取消/休息/预算耗尽/并发超限 ⇒ 不开始", () => {
    expect(evaluateExploreTrialStart(baseInput({ isUserCancelled: true }))).toMatchObject({
      reasonCode: "user-cancelled",
    });
    expect(evaluateExploreTrialStart(baseInput({ isRestPeriod: true }))).toMatchObject({
      reasonCode: "rest-period",
    });
    expect(
      evaluateExploreTrialStart(baseInput({ remainingBudget: { maximumTrials: 0, tokens: 10 } })),
    ).toMatchObject({ reasonCode: "budget-exhausted" });
    expect(
      evaluateExploreTrialStart(baseInput({ activeTrialCount: 2 })),
    ).toMatchObject({ reasonCode: "concurrency-exceeded" });
  });

  it("④ 相同参数+种子+版本 ⇒ 去重复用（不重跑、不消耗预算）", () => {
    const record = buildExploreTrialRecord({
      parameterCombinationIdentifier: "combo-1",
      seedIdentifier: "seed-42",
      versionIdentifier: "v1",
      isolationKind: "fixture",
      resultKind: "failed",
      transcriptHash: "0123456789abcdef",
    });
    if (record.kind !== "built") throw new Error("应生成记录");
    const decision = evaluateExploreTrialStart(
      baseInput({ existingTrials: [record.record] }),
    );
    expect(decision.kind).toBe("deduplicated-replay");
    if (decision.kind !== "deduplicated-replay") throw new Error("应去重");
    expect(decision.existingTrial.resultKind).toBe("failed");
    expect(decision.reason).toContain("不重跑");
  });

  it("⑤ 参数/种子/版本任一不同 ⇒ 新试验键", () => {
    const base = computeExploreTrialKey({
      parameterCombinationIdentifier: "combo-1",
      seedIdentifier: "seed-42",
      versionIdentifier: "v1",
    });
    expect(
      computeExploreTrialKey({
        parameterCombinationIdentifier: "combo-1",
        seedIdentifier: "seed-43",
        versionIdentifier: "v1",
      }),
    ).not.toBe(base);
    expect(
      computeExploreTrialKey({
        parameterCombinationIdentifier: "combo-1",
        seedIdentifier: "seed-42",
        versionIdentifier: "v2",
      }),
    ).not.toBe(base);
  });

  it("⑥ 记录必须带可复跑证据哈希；阴性结果也保留", () => {
    expect(
      buildExploreTrialRecord({
        parameterCombinationIdentifier: "combo-1",
        seedIdentifier: "seed-42",
        versionIdentifier: "v1",
        isolationKind: "fake-service",
        resultKind: "inconclusive",
        transcriptHash: "",
      }).kind,
    ).toBe("rejected");

    const negative = buildExploreTrialRecord({
      parameterCombinationIdentifier: "combo-1",
      seedIdentifier: "seed-42",
      versionIdentifier: "v1",
      isolationKind: "fake-service",
      resultKind: "failed",
      transcriptHash: "abcdef0123456789",
    });
    expect(negative.kind).toBe("built");
    if (negative.kind !== "built") throw new Error("应生成记录");
    expect(negative.record.resultKind).toBe("failed");
  });

  it("⑦ 重启后预算不刷新：有快照沿用、无快照视为未知（不发新预算）", () => {
    expect(
      restoreExploreBudgetAfterRestart({ persistedBudget: { maximumTrials: 3, tokens: 900 } }),
    ).toMatchObject({ kind: "restored", budget: { maximumTrials: 3, tokens: 900 } });
    const unknown = restoreExploreBudgetAfterRestart({ persistedBudget: null });
    expect(unknown.kind).toBe("unknown-budget");
    expect(unknown.budget).toEqual({ maximumTrials: 0, tokens: 0 });
    expect(unknown.reason).toContain("不刷新");
  });

  it("⑧ 正常条件 ⇒ 开始，并给出试验键", () => {
    const decision = evaluateExploreTrialStart(baseInput());
    expect(decision.kind).toBe("start");
    if (decision.kind !== "start") throw new Error("应开始");
    expect(decision.trialKey).toHaveLength(64);
  });
});
