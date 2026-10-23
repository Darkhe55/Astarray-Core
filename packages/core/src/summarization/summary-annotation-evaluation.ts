/**
 * SUM-02-04（2026-10-23）：**人工标注样本的评估口径**。
 *
 * 卡内/ADR-0037 要求：
 * - 摘要质量**只能用人工标注评估**，**不能用生成模型自评通过**；
 * - 质量指标依赖标注数量：样本不足时仍给出分母，**报告必须标明样本规模**；
 * - 引用存在 ≠ 语义正确 ⇒ 标签必须区分"支持/部分支持/遗漏/错误归因"。
 *
 * 本模块只做**判定与计数**（纯函数）；不读取原文、不调用模型。
 */

/** 标注标签（四类，互斥）。 */
export const SUMMARY_ANNOTATION_LABELS = [
  "supported",
  "partially-supported",
  "missing",
  "misattributed",
] as const;
export type SummaryAnnotationLabel = (typeof SUMMARY_ANNOTATION_LABELS)[number];

/** 标注者类型：只有 `human` 可用；模型/未知一律拒绝。 */
export type SummaryAnnotationAnnotatorKind = "human" | "model" | "unknown";

/** 单条标注样本。 */
export interface SummaryAnnotationSample {
  readonly sampleIdentifier: string;
  /** 摘要里的声明（被核查对象）。 */
  readonly claimText: string;
  /** 原文证据引用（可为空 ⇒ 该样本无证据，按遗漏处理）。 */
  readonly evidenceText?: string;
  readonly label: SummaryAnnotationLabel;
  readonly annotatorKind: SummaryAnnotationAnnotatorKind;
  readonly annotatorIdentifier?: string;
}

/** 评估结果。 */
export interface SummaryAnnotationEvaluation {
  readonly totalSampleCount: number;
  readonly usableSampleCount: number;
  readonly rejectedSamples: ReadonlyArray<{
    readonly sampleIdentifier: string;
    readonly reasonCode: "non-human-annotator" | "empty-claim" | "invalid-label" | "duplicate-sample";
    readonly reason: string;
  }>;
  readonly labelCounts: Record<SummaryAnnotationLabel, number>;
  /** precision = 支持数 / 可用样本数（分母显式给出）。 */
  readonly precisionNumerator: number;
  readonly precisionDenominator: number;
  readonly precision: number | null;
  /** recall = （支持 + 部分支持）/ 可用样本数（分母显式给出）。 */
  readonly recallNumerator: number;
  readonly recallDenominator: number;
  readonly recall: number | null;
  readonly minimumRequiredSampleCount: number;
  readonly isSampleSizeSufficient: boolean;
  readonly isModelSelfAnnotated: boolean;
  readonly conclusion: "evaluated" | "insufficient-sample" | "rejected-model-self-annotation";
  readonly notice: string;
}

/** 默认最低样本数（样本不足时不得给"改善百分比"）。 */
export const DEFAULT_MINIMUM_ANNOTATION_SAMPLE_COUNT = 30;

/**
 * 评估一组人工标注样本。
 *
 * 纪律：
 * 1. **任何非 human 标注者出现 ⇒ 整体结论为 `rejected-model-self-annotation`**（样本不参与计数）；
 * 2. 重复 sampleIdentifier 只计首次；
 * 3. 可用样本数 < 最低样本数 ⇒ `insufficient-sample`，仍给分母与计数，但不宣称改善；
 * 4. 无可用样本 ⇒ 指标为 null（不返回 0 冒充"完全失败"）。
 */
export function evaluateSummaryAnnotations(input: {
  readonly samples: ReadonlyArray<SummaryAnnotationSample>;
  readonly minimumRequiredSampleCount?: number;
}): SummaryAnnotationEvaluation {
  const minimumRequiredSampleCount =
    input.minimumRequiredSampleCount ?? DEFAULT_MINIMUM_ANNOTATION_SAMPLE_COUNT;
  const labelCounts: Record<SummaryAnnotationLabel, number> = {
    supported: 0,
    "partially-supported": 0,
    missing: 0,
    misattributed: 0,
  };
  const rejectedSamples: Array<{
    sampleIdentifier: string;
    reasonCode: "non-human-annotator" | "empty-claim" | "invalid-label" | "duplicate-sample";
    reason: string;
  }> = [];
  const seenIdentifiers = new Set<string>();
  let usableSampleCount = 0;
  let isModelSelfAnnotated = false;

  for (const sample of input.samples) {
    if (sample.annotatorKind !== "human") {
      isModelSelfAnnotated = true;
      rejectedSamples.push({
        sampleIdentifier: sample.sampleIdentifier,
        reasonCode: "non-human-annotator",
        reason:
          "标注者不是人工（" +
          sample.annotatorKind +
          "）：模型自评不得用于通过质量评估。",
      });
      continue;
    }
    if (sample.claimText.trim() === "") {
      rejectedSamples.push({
        sampleIdentifier: sample.sampleIdentifier,
        reasonCode: "empty-claim",
        reason: "声明为空：无法核查。",
      });
      continue;
    }
    if (!(SUMMARY_ANNOTATION_LABELS as ReadonlyArray<string>).includes(sample.label)) {
      rejectedSamples.push({
        sampleIdentifier: sample.sampleIdentifier,
        reasonCode: "invalid-label",
        reason: "标签不在四类之内：`" + String(sample.label) + "`。",
      });
      continue;
    }
    if (seenIdentifiers.has(sample.sampleIdentifier)) {
      rejectedSamples.push({
        sampleIdentifier: sample.sampleIdentifier,
        reasonCode: "duplicate-sample",
        reason: "重复样本：只计首次。",
      });
      continue;
    }
    seenIdentifiers.add(sample.sampleIdentifier);
    usableSampleCount += 1;
    labelCounts[sample.label] += 1;
  }

  const precisionNumerator = labelCounts.supported;
  const recallNumerator = labelCounts.supported + labelCounts["partially-supported"];
  const precision = usableSampleCount === 0 ? null : precisionNumerator / usableSampleCount;
  const recall = usableSampleCount === 0 ? null : recallNumerator / usableSampleCount;
  const isSampleSizeSufficient = usableSampleCount >= minimumRequiredSampleCount;

  const conclusion: SummaryAnnotationEvaluation["conclusion"] = isModelSelfAnnotated
    ? "rejected-model-self-annotation"
    : isSampleSizeSufficient
      ? "evaluated"
      : "insufficient-sample";

  const notice =
    conclusion === "rejected-model-self-annotation"
      ? "存在非人工标注者的样本：整份评估不成立（卡内：不能用生成模型自评通过）。"
      : conclusion === "insufficient-sample"
        ? "可用人工标注仅 " +
          String(usableSampleCount) +
          " 条（低于 " +
          String(minimumRequiredSampleCount) +
          "）：给出分母但**不得**宣称改善百分比。"
        : "人工标注 " + String(usableSampleCount) + " 条：指标按四类标签计算，分母已在结果中给出。";

  return {
    totalSampleCount: input.samples.length,
    usableSampleCount,
    rejectedSamples,
    labelCounts,
    precisionNumerator,
    precisionDenominator: usableSampleCount,
    precision,
    recallNumerator,
    recallDenominator: usableSampleCount,
    recall,
    minimumRequiredSampleCount,
    isSampleSizeSufficient,
    isModelSelfAnnotated,
    conclusion,
    notice,
  };
}
