/**
 * EXPLORE-01-03 判定契约的反例（2026-10-20 R104）。
 *
 * 核心：**一次成功不得称为稳定**；同种子重复不算独立；阴性结果保留；绝不自动合并；超预算即拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateExploreVerification,
  type ExploreVerificationTrialSummary,
} from "../../../packages/core/src/orchestration/explore-verification-contract.js";

function trial(overrides: Partial<ExploreVerificationTrialSummary> = {}): ExploreVerificationTrialSummary {
  return {
    trialKey: "key-1",
    seed: "seed-1",
    inputFingerprint: "input-1",
    isSuccess: true,
    evidenceHash: "hash-1",
    coversBoundary: false,
    coversRegression: false,
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    trials: [],
    spentWallClockSeconds: 100,
    spentRequestCount: 10,
    spentEstimatedCostAmount: 0,
    maximumWallClockSeconds: 1000,
    maximumRequestCount: 100,
    maximumEstimatedCostAmount: null,
    isSelfEvaluationOnly: false,
    ...overrides,
  } as Parameters<typeof evaluateExploreVerification>[0];
}

/** 一组"证据齐备"的试验：3 次成功、2 种输入、2 类种子、覆盖边界与回归。 */
function sufficientTrials(): ExploreVerificationTrialSummary[] {
  return [
    trial({ trialKey: "a", seed: "s1", inputFingerprint: "in-1", coversBoundary: true }),
    trial({ trialKey: "b", seed: "s2", inputFingerprint: "in-1", coversRegression: true }),
    trial({ trialKey: "c", seed: "s2", inputFingerprint: "in-2" }),
  ];
}

describe("EXPLORE-01-03 独立验证判定", () => {
  it("① 一次成功 ⇒ 证据不足（不得称稳定），且**绝不自动合并**", () => {
    const decision = evaluateExploreVerification(
      baseInput({ trials: [trial({ coversBoundary: true, coversRegression: true })] }),
    );
    expect(decision.kind).toBe("insufficient-evidence");
    if (decision.kind !== "insufficient-evidence") throw new Error("类型收窄失败");
    expect(decision.missingEvidence).toContain("successful-runs");
    expect(decision.isAutoMerged).toBe(false);
  });

  it("② 同种子同输入重复三次 ⇒ 不算独立（缺 distinct-inputs / independent-seeds / 覆盖）", () => {
    const decision = evaluateExploreVerification(
      baseInput({
        trials: [trial({ trialKey: "a" }), trial({ trialKey: "b" }), trial({ trialKey: "c" })],
      }),
    );
    expect(decision.kind).toBe("insufficient-evidence");
    if (decision.kind !== "insufficient-evidence") throw new Error("类型收窄失败");
    expect(decision.missingEvidence).toEqual(
      expect.arrayContaining([
        "distinct-inputs",
        "independent-seeds",
        "boundary-coverage",
        "regression-coverage",
      ]),
    );
  });

  it("③ 缺证据哈希的试验不参与独立计数", () => {
    const decision = evaluateExploreVerification(
      baseInput({
        trials: [
          trial({ trialKey: "a", evidenceHash: null, coversBoundary: true }),
          trial({ trialKey: "b", seed: "s2", inputFingerprint: "in-2" }),
        ],
      }),
    );
    expect(decision.kind).toBe("insufficient-evidence");
    if (decision.kind !== "insufficient-evidence") throw new Error("类型收窄失败");
    expect(decision.missingEvidence).toEqual(
      expect.arrayContaining(["successful-runs", "evidence-hashes"]),
    );
  });

  it("④ 证据齐备 ⇒ verified-candidate，但仍要求普通验收、不自动合并、阴性结果保留", () => {
    const decision = evaluateExploreVerification(
      baseInput({
        trials: [
          ...sufficientTrials(),
          trial({ trialKey: "d", isSuccess: false, seed: "s3", inputFingerprint: "in-3" }),
        ],
      }),
    );
    expect(decision.kind).toBe("verified-candidate");
    if (decision.kind !== "verified-candidate") throw new Error("类型收窄失败");
    expect(decision.isAutoMerged).toBe(false);
    expect(decision.isNegativeResultRetained).toBe(true);
    expect(decision.negativeResultCount).toBe(1);
    expect(decision.requiredNextStep).toContain("普通验收");
    // 稳定性必须给出**范围**，不能一句"稳定"
    expect(decision.stableScope).toContain("未覆盖的参数空间不在此范围内");
  });

  it("⑤ 只有模型自评 ⇒ 拒绝（不得替代独立证据）", () => {
    const decision = evaluateExploreVerification(
      baseInput({ trials: sufficientTrials(), isSelfEvaluationOnly: true }),
    );
    expect(decision).toMatchObject({ kind: "rejected", reasonCode: "self-evaluation-only" });
  });

  it("⑥ 超预算 ⇒ 拒绝（墙钟/请求/金额任一超额，不续预算）", () => {
    for (const overrides of [
      { spentWallClockSeconds: 1001 },
      { spentRequestCount: 101 },
      { maximumEstimatedCostAmount: 5, spentEstimatedCostAmount: 6 },
    ]) {
      const decision = evaluateExploreVerification(
        baseInput({ trials: sufficientTrials(), ...overrides }),
      );
      expect(decision, JSON.stringify(overrides)).toMatchObject({
        kind: "rejected",
        reasonCode: "budget-exceeded",
      });
    }
    // 未设金额预算（null）不因金额被拒
    const noAmountBudget = evaluateExploreVerification(
      baseInput({ trials: sufficientTrials(), spentEstimatedCostAmount: 999 }),
    );
    expect(noAmountBudget.kind).toBe("verified-candidate");
  });

  it("⑦ 没有任何成功试验 ⇒ 拒绝，但阴性结果计数如实", () => {
    const decision = evaluateExploreVerification(
      baseInput({
        trials: [
          trial({ trialKey: "a", isSuccess: false, seed: "s1", inputFingerprint: "in-1" }),
          trial({ trialKey: "b", isSuccess: false, seed: "s2", inputFingerprint: "in-2" }),
        ],
      }),
    );
    expect(decision).toMatchObject({ kind: "rejected", reasonCode: "no-successful-trial" });
    expect(decision.negativeResultCount).toBe(2);
    expect(decision.isAutoMerged).toBe(false);
  });
});
