/**
 * FOLD-01-03（2026-10-20 R107）：**成本收益判定**契约。
 *
 * 卡内依据（`docs/tasks/EXP01_...` §2 FOLD-01-03 "测完整成本收益"；§5 "测量端到端净收益、无效探索成本、
 * 额外 token 开销，**不以模型自评通过代替证据**"）。
 *
 * 把"折叠到底值不值"变成可执行判定，纪律：
 * 1. **样本不足不下结论**：任一侧有效样本 < 3 ⇒ `insufficient-evidence`（不得用 1 次运行宣称收益）；
 * 2. **有失败就不谈收益**：折叠侧存在失败运行 ⇒ `blocked-by-failures`（先修回归，再谈成本）；
 * 3. **unknown 不记作零**：某项指标为 `null` 的样本**不参与该指标均值**，并计入 `unknownSampleCount`；
 * 4. **收益必须双向且有幅度**：墙钟与 token **同时**改善 ≥10% 才算 `net-benefit`，否则 `no-net-benefit`
 *    （如实给出**含负值**的差值，不粉饰）；
 * 5. **稳定性区间**：任一指标 (max−min)/mean > 0.5 ⇒ `isClaimStable: false`（波动过大不称稳定）；
 * 6. **绝不自动推广**：`isAutoPromoted: false` 恒为 false。
 *
 * ## 边界
 * 不采集、不执行：只对已有测量结果给出判定。
 */
/** 一次运行的测量结果（`null` 表示该指标未知）。 */
export interface FoldRunMeasurementV1 {
  readonly runIdentifier: string;
  readonly wallClockSeconds: number | null;
  readonly stepCount: number | null;
  readonly modelRequestCount: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly isFailure: boolean;
}

/** 判定结论。 */
export type FoldCostBenefitDecision =
  | {
      readonly kind: "insufficient-evidence";
      readonly baselineSampleCount: number;
      readonly foldedSampleCount: number;
      readonly unknownSampleCount: number;
      readonly isAutoPromoted: false;
      readonly reason: string;
    }
  | {
      readonly kind: "blocked-by-failures";
      readonly foldedFailureCount: number;
      readonly unknownSampleCount: number;
      readonly isAutoPromoted: false;
      readonly reason: string;
    }
  | {
      readonly kind: "net-benefit" | "no-net-benefit";
      readonly wallClockImprovementRatio: number;
      readonly tokenImprovementRatio: number;
      readonly unknownSampleCount: number;
      readonly isClaimStable: boolean;
      readonly isAutoPromoted: false;
      readonly reason: string;
    };

function meanOfKnownValues(values: ReadonlyArray<number | null>): {
  readonly mean: number | null;
  readonly knownCount: number;
  readonly isStableEnough: boolean;
} {
  const knownValues = values.filter((value): value is number => value !== null);
  if (knownValues.length === 0) {
    return { mean: null, knownCount: 0, isStableEnough: false };
  }
  const mean = knownValues.reduce((sum, value) => sum + value, 0) / knownValues.length;
  const minimum = Math.min(...knownValues);
  const maximum = Math.max(...knownValues);
  const isStableEnough = mean === 0 ? true : (maximum - minimum) / Math.abs(mean) <= 0.5;
  return { mean, knownCount: knownValues.length, isStableEnough };
}

/** 判定折叠是否带来净收益。 */
export function evaluateFoldCostBenefit(input: {
  readonly baselineRuns: ReadonlyArray<FoldRunMeasurementV1>;
  readonly foldedRuns: ReadonlyArray<FoldRunMeasurementV1>;
  /** 收益幅度门槛（缺省 0.1 = 10%）。 */
  readonly minimumImprovementRatio?: number;
}): FoldCostBenefitDecision {
  const minimumImprovementRatio = input.minimumImprovementRatio ?? 0.1;
  const unknownSampleCount =
    [...input.baselineRuns, ...input.foldedRuns].filter(
      (run) =>
        run.wallClockSeconds === null ||
        run.inputTokens === null ||
        run.outputTokens === null,
    ).length;

  const baselineKnownRuns = input.baselineRuns.filter(
    (run) => run.wallClockSeconds !== null && run.inputTokens !== null && run.outputTokens !== null,
  );
  const foldedKnownRuns = input.foldedRuns.filter(
    (run) => run.wallClockSeconds !== null && run.inputTokens !== null && run.outputTokens !== null,
  );

  if (baselineKnownRuns.length < 3 || foldedKnownRuns.length < 3) {
    return {
      kind: "insufficient-evidence",
      baselineSampleCount: baselineKnownRuns.length,
      foldedSampleCount: foldedKnownRuns.length,
      unknownSampleCount,
      isAutoPromoted: false,
      reason: `有效样本不足（基线 ${String(baselineKnownRuns.length)} / 折叠 ${String(foldedKnownRuns.length)}，各需 ≥3）：不得据此宣称收益。`,
    };
  }

  const foldedFailureCount = input.foldedRuns.filter((run) => run.isFailure).length;
  if (foldedFailureCount > 0) {
    return {
      kind: "blocked-by-failures",
      foldedFailureCount,
      unknownSampleCount,
      isAutoPromoted: false,
      reason: `折叠侧存在 ${String(foldedFailureCount)} 次失败运行：先修回归，再谈成本收益。`,
    };
  }

  const baselineWallClock = meanOfKnownValues(baselineKnownRuns.map((run) => run.wallClockSeconds));
  const foldedWallClock = meanOfKnownValues(foldedKnownRuns.map((run) => run.wallClockSeconds));
  const baselineTokens = meanOfKnownValues(
    baselineKnownRuns.map((run) => (run.inputTokens ?? 0) + (run.outputTokens ?? 0)),
  );
  const foldedTokens = meanOfKnownValues(
    foldedKnownRuns.map((run) => (run.inputTokens ?? 0) + (run.outputTokens ?? 0)),
  );

  if (
    baselineWallClock.mean === null ||
    foldedWallClock.mean === null ||
    baselineTokens.mean === null ||
    foldedTokens.mean === null
  ) {
    return {
      kind: "insufficient-evidence",
      baselineSampleCount: baselineKnownRuns.length,
      foldedSampleCount: foldedKnownRuns.length,
      unknownSampleCount,
      isAutoPromoted: false,
      reason: "关键指标均值为未知（全为 null）：不猜测。",
    };
  }

  // 改善比例：正值表示折叠更省
  const wallClockImprovementRatio =
    baselineWallClock.mean === 0
      ? 0
      : (baselineWallClock.mean - foldedWallClock.mean) / baselineWallClock.mean;
  const tokenImprovementRatio =
    baselineTokens.mean === 0 ? 0 : (baselineTokens.mean - foldedTokens.mean) / baselineTokens.mean;

  const isStableEnough =
    baselineWallClock.isStableEnough &&
    foldedWallClock.isStableEnough &&
    baselineTokens.isStableEnough &&
    foldedTokens.isStableEnough;

  const hasBothImprovements =
    wallClockImprovementRatio >= minimumImprovementRatio &&
    tokenImprovementRatio >= minimumImprovementRatio;

  if (!hasBothImprovements) {
    return {
      kind: "no-net-benefit",
      wallClockImprovementRatio,
      tokenImprovementRatio,
      unknownSampleCount,
      isClaimStable: isStableEnough,
      isAutoPromoted: false,
      reason: `未同时达到 ${String(Math.round(minimumImprovementRatio * 100))}% 改善（墙钟 ${(wallClockImprovementRatio * 100).toFixed(1)}% / token ${(tokenImprovementRatio * 100).toFixed(1)}%）：不宣称收益。`,
    };
  }

  return {
    kind: "net-benefit",
    wallClockImprovementRatio,
    tokenImprovementRatio,
    unknownSampleCount,
    isClaimStable: isStableEnough,
    isAutoPromoted: false,
    reason: `净收益成立：墙钟 ${(wallClockImprovementRatio * 100).toFixed(1)}% / token ${(tokenImprovementRatio * 100).toFixed(1)}%（阈值 ${String(Math.round(minimumImprovementRatio * 100))}%）；是否推广仍由用户决定。`,
  };
}
