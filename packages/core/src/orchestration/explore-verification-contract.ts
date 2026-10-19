/**
 * EXPLORE-01-03（2026-10-20 R104）：**独立验证与候选回交**契约。
 *
 * 卡内依据（`docs/tasks/EXP01_..._TASK_CARDS.md` §3）：
 * "找到可行解后独立复核，覆盖重复试验、不同输入、边界与回归；报告稳定性的实测范围和局限，
 * **不把一次成功称为稳定方案**"；"成果形成带证据的方法候选/经验；**进入生产需普通验收及受控合并**"；
 * "不把模型探索结论代替用户最终判断"；"允许记录**阴性结果**"；§5 "不以模型自评通过代替证据"。
 *
 * 本模块只做**判定**（纯函数），回答一个问题：这批试验结果是否足以称为"稳定候选"？
 *
 * 判定纪律：
 * 1. **一次成功不是稳定**：`successfulRunCount < 3` 或 `distinctInputCount < 2` ⇒ `insufficient-evidence`；
 * 2. **同种子重复不算独立**：独立证据要求"不同种子或不同输入"，同种子重复只计一次；
 * 3. **必须覆盖边界与回归**：缺任一项 ⇒ `insufficient-evidence`（并说明缺哪项）；
 * 4. **阴性结果保留**：`negativeResultCount` 如实计数，**不得**因为"失败样本"而不给结论 —— 它不阻塞判定，
 *    但必须出现在报告里（`isNegativeResultRetained: true`）；
 * 5. **成本可查**：`wallClockSeconds`/`requestCount`/`estimatedCostAmount` 必填；超预算 ⇒ `rejected`；
 * 6. **绝不自动合并/推广**：`isAutoMerged: false` 恒为 false，`requiredNextStep` 必须指明"需普通验收"。
 *
 * ## 边界
 * 不执行试验、不读写文件、不调用模型：只对**已有证据**给出判定。
 */
/** 一次试验的证据摘要（来自 EXPLORE-01-02 的记录）。 */
export interface ExploreVerificationTrialSummary {
  readonly trialKey: string;
  /** 该试验使用的随机种子（无随机性时为 null）。 */
  readonly seed: string | null;
  /** 该试验使用的输入指纹（用于判断"不同输入"）。 */
  readonly inputFingerprint: string;
  readonly isSuccess: boolean;
  /** 可复跑证据哈希（缺哈希的试验不参与"独立验证"计数）。 */
  readonly evidenceHash: string | null;
  /** 是否覆盖边界条件。 */
  readonly coversBoundary: boolean;
  /** 是否覆盖回归样本。 */
  readonly coversRegression: boolean;
}

/** 判定结论。 */
export type ExploreVerificationDecision =
  | {
      readonly kind: "verified-candidate";
      readonly stableScope: string;
      readonly limitations: ReadonlyArray<string>;
      readonly negativeResultCount: number;
      readonly isNegativeResultRetained: true;
      readonly isAutoMerged: false;
      readonly requiredNextStep: "普通验收与受控合并（由用户/验收者执行）";
      readonly reason: string;
    }
  | {
      readonly kind: "insufficient-evidence";
      readonly missingEvidence: ReadonlyArray<
        | "successful-runs"
        | "distinct-inputs"
        | "independent-seeds"
        | "boundary-coverage"
        | "regression-coverage"
        | "evidence-hashes"
      >;
      readonly negativeResultCount: number;
      readonly isAutoMerged: false;
      readonly reason: string;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode: "budget-exceeded" | "no-successful-trial" | "self-evaluation-only";
      readonly negativeResultCount: number;
      readonly isAutoMerged: false;
      readonly reason: string;
    };

/** 独立验证判定。 */
export function evaluateExploreVerification(input: {
  readonly trials: ReadonlyArray<ExploreVerificationTrialSummary>;
  /** 预算（与 EXPLORE-01-01 的五维预算对齐的**已消耗**部分）。 */
  readonly spentWallClockSeconds: number;
  readonly spentRequestCount: number;
  readonly spentEstimatedCostAmount: number | null;
  readonly maximumWallClockSeconds: number;
  readonly maximumRequestCount: number;
  /** 金额预算为 null 表示"未设金额预算"（不是 0 预算）。 */
  readonly maximumEstimatedCostAmount: number | null;
  /** 结论是否**仅**来自模型自评（无独立证据）。 */
  readonly isSelfEvaluationOnly: boolean;
}): ExploreVerificationDecision {
  const negativeResultCount = input.trials.filter((trial) => !trial.isSuccess).length;

  if (input.isSelfEvaluationOnly) {
    return {
      kind: "rejected",
      reasonCode: "self-evaluation-only",
      negativeResultCount,
      isAutoMerged: false,
      reason: "只有模型自评：不得替代独立证据与用户最终判断。",
    };
  }
  if (input.spentWallClockSeconds > input.maximumWallClockSeconds) {
    return {
      kind: "rejected",
      reasonCode: "budget-exceeded",
      negativeResultCount,
      isAutoMerged: false,
      reason: "超出墙钟预算：不得以'已投入'为由继续或续预算。",
    };
  }
  if (input.spentRequestCount > input.maximumRequestCount) {
    return {
      kind: "rejected",
      reasonCode: "budget-exceeded",
      negativeResultCount,
      isAutoMerged: false,
      reason: "超出请求预算：不得自动续预算。",
    };
  }
  if (
    input.maximumEstimatedCostAmount !== null &&
    input.spentEstimatedCostAmount !== null &&
    input.spentEstimatedCostAmount > input.maximumEstimatedCostAmount
  ) {
    return {
      kind: "rejected",
      reasonCode: "budget-exceeded",
      negativeResultCount,
      isAutoMerged: false,
      reason: "超出金额预算：不购买额度、不切换未授权模型。",
    };
  }

  const successfulTrials = input.trials.filter((trial) => trial.isSuccess);
  if (successfulTrials.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "no-successful-trial",
      negativeResultCount,
      isAutoMerged: false,
      reason: "没有任何成功试验：阴性结果保留，但不能形成候选。",
    };
  }

  const missingEvidence: Array<
    | "successful-runs"
    | "distinct-inputs"
    | "independent-seeds"
    | "boundary-coverage"
    | "regression-coverage"
    | "evidence-hashes"
  > = [];

  // 只有**带证据哈希**的成功试验才算独立证据
  const evidencedSuccesses = successfulTrials.filter(
    (trial) => trial.evidenceHash !== null && trial.evidenceHash.trim() !== "",
  );
  if (evidencedSuccesses.length < 3) missingEvidence.push("successful-runs");

  const distinctInputCount = new Set(evidencedSuccesses.map((trial) => trial.inputFingerprint)).size;
  if (distinctInputCount < 2) missingEvidence.push("distinct-inputs");

  // 同种子重复不算独立：不同种子（含 null 视为"无随机性"一类）至少两种
  const distinctSeedKeys = new Set(
    evidencedSuccesses.map((trial) => (trial.seed === null ? "no-seed" : `seed:${trial.seed}`)),
  );
  if (distinctSeedKeys.size < 2) missingEvidence.push("independent-seeds");

  if (!evidencedSuccesses.some((trial) => trial.coversBoundary)) missingEvidence.push("boundary-coverage");
  if (!evidencedSuccesses.some((trial) => trial.coversRegression))
    missingEvidence.push("regression-coverage");
  if (successfulTrials.some((trial) => trial.evidenceHash === null)) missingEvidence.push("evidence-hashes");

  if (missingEvidence.length > 0) {
    return {
      kind: "insufficient-evidence",
      missingEvidence,
      negativeResultCount,
      isAutoMerged: false,
      reason: `证据不足（缺 ${missingEvidence.join(" / ")}）：一次成功不得称为稳定方案。`,
    };
  }

  return {
    kind: "verified-candidate",
    stableScope: `在 ${String(evidencedSuccesses.length)} 次带证据试验、${String(distinctInputCount)} 种输入、${String(distinctSeedKeys.size)} 类种子下稳定；未覆盖的参数空间不在此范围内。`,
    limitations: [
      "只覆盖已记录的输入/参数空间；未测范围不得推断",
      "随机探索的种子仅帮助复现，不承诺远端模型完全确定性",
      "阴性结果已保留，未归因为已排除",
    ],
    negativeResultCount,
    isNegativeResultRetained: true,
    isAutoMerged: false,
    requiredNextStep: "普通验收与受控合并（由用户/验收者执行）",
    reason: "证据齐备：可回交为**候选方法/经验**，仍需普通验收后才可进入生产。",
  };
}

