/**
 * FOLD 成本收益判定的反例（2026-10-20 R107）。
 *
 * 核心：样本不足不下结论、有失败不谈收益、unknown 不记零、双向改善才称收益、波动过大不称稳定。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateFoldCostBenefit,
  type FoldRunMeasurementV1,
} from "../../../packages/core/src/orchestration/workflow-fold-cost-benefit.js";

function run(
  overrides: Partial<FoldRunMeasurementV1> = {},
): FoldRunMeasurementV1 {
  return {
    runIdentifier: "run-1",
    wallClockSeconds: 100,
    stepCount: 10,
    modelRequestCount: 5,
    inputTokens: 1000,
    outputTokens: 500,
    isFailure: false,
    ...overrides,
  };
}

function threeRuns(overrides: Partial<FoldRunMeasurementV1> = {}): FoldRunMeasurementV1[] {
  return [run({ runIdentifier: "a", ...overrides }), run({ runIdentifier: "b", ...overrides }), run({ runIdentifier: "c", ...overrides })];
}

describe("FOLD 成本收益判定", () => {
  it("① 任一侧有效样本 <3 ⇒ insufficient-evidence（不得用一两次运行宣称收益）", () => {
    for (const input of [
      { baselineRuns: [run()], foldedRuns: threeRuns({ wallClockSeconds: 50 }) },
      { baselineRuns: threeRuns(), foldedRuns: [run({ wallClockSeconds: 50 })] },
    ]) {
      const decision = evaluateFoldCostBenefit(input);
      expect(decision.kind).toBe("insufficient-evidence");
      expect(decision.isAutoPromoted).toBe(false);
    }
  });

  it("② 折叠侧存在失败 ⇒ blocked-by-failures（先修回归再谈成本）", () => {
    const decision = evaluateFoldCostBenefit({
      baselineRuns: threeRuns(),
      foldedRuns: [
        run({ runIdentifier: "a", wallClockSeconds: 10, inputTokens: 10, outputTokens: 10 }),
        run({ runIdentifier: "b", wallClockSeconds: 10, inputTokens: 10, outputTokens: 10 }),
        run({ runIdentifier: "c", wallClockSeconds: 10, inputTokens: 10, outputTokens: 10, isFailure: true }),
      ],
    });
    expect(decision).toMatchObject({ kind: "blocked-by-failures", foldedFailureCount: 1 });
  });

  it("③ unknown 指标不进均值但**计数**（不记作零）", () => {
    const decision = evaluateFoldCostBenefit({
      baselineRuns: [
        run({ runIdentifier: "a" }),
        run({ runIdentifier: "b" }),
        run({ runIdentifier: "c" }),
        run({ runIdentifier: "d", wallClockSeconds: null }),
      ],
      foldedRuns: threeRuns({ wallClockSeconds: 50, inputTokens: 500, outputTokens: 250 }),
    });
    expect(decision.kind).toBe("net-benefit");
    if (decision.kind !== "net-benefit") throw new Error("类型收窄失败");
    // 第 4 条的墙钟未知：只计数，不当作 0 参与均值
    expect(decision.unknownSampleCount).toBeGreaterThanOrEqual(1);
  });

  it("④ 墙钟与 token 同时改善 ≥10% ⇒ net-benefit（仍不自动推广）", () => {
    const decision = evaluateFoldCostBenefit({
      baselineRuns: threeRuns({ wallClockSeconds: 100, inputTokens: 1000, outputTokens: 500 }),
      foldedRuns: threeRuns({ wallClockSeconds: 60, inputTokens: 400, outputTokens: 200 }),
    });
    expect(decision.kind).toBe("net-benefit");
    if (decision.kind !== "net-benefit") throw new Error("类型收窄失败");
    expect(decision.wallClockImprovementRatio).toBeCloseTo(0.4, 5);
    expect(decision.isAutoPromoted).toBe(false);
    expect(decision.isClaimStable).toBe(true);
  });

  it("⑤ 只有一项改善 ⇒ no-net-benefit，且差值如实（不粉饰）", () => {
    const decision = evaluateFoldCostBenefit({
      baselineRuns: threeRuns({ wallClockSeconds: 100, inputTokens: 1000, outputTokens: 500 }),
      // 墙钟降 40%，但 token 反而更多（负改善）
      foldedRuns: threeRuns({ wallClockSeconds: 60, inputTokens: 2000, outputTokens: 1000 }),
    });
    expect(decision.kind).toBe("no-net-benefit");
    if (decision.kind !== "no-net-benefit") throw new Error("类型收窄失败");
    expect(decision.wallClockImprovementRatio).toBeGreaterThan(0.1);
    expect(decision.tokenImprovementRatio).toBeLessThan(0);
  });

  it("⑥ 指标波动过大 ⇒ isClaimStable=false（一次成功不是稳定）", () => {
    const decision = evaluateFoldCostBenefit({
      baselineRuns: [
        run({ runIdentifier: "a", wallClockSeconds: 10 }),
        run({ runIdentifier: "b", wallClockSeconds: 100 }),
        run({ runIdentifier: "c", wallClockSeconds: 1000 }),
      ],
      foldedRuns: threeRuns({ wallClockSeconds: 5, inputTokens: 100, outputTokens: 50 }),
    });
    expect(decision.kind).toBe("net-benefit");
    if (decision.kind !== "net-benefit") throw new Error("类型收窄失败");
    expect(decision.isClaimStable).toBe(false);
  });

  it("⑦ 关键指标全为未知 ⇒ insufficient-evidence（不猜测）", () => {
    const decision = evaluateFoldCostBenefit({
      baselineRuns: threeRuns({ wallClockSeconds: null }),
      foldedRuns: threeRuns({ wallClockSeconds: 50 }),
    });
    expect(decision.kind).toBe("insufficient-evidence");
  });
});
