/**
 * SUM-02-04 人工标注评估反例（2026-10-23）。
 *
 * 覆盖：模型自评整体拒绝、样本不足如实标注、重复样本只计首次、空声明/非法标签拒绝、
 * 分母显式、四类标签各自计数、无样本时指标为 null（不返回 0）。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MINIMUM_ANNOTATION_SAMPLE_COUNT,
  evaluateSummaryAnnotations,
  type SummaryAnnotationSample,
} from "../../../packages/core/src/summarization/summary-annotation-evaluation.js";

function sample(overrides: Partial<SummaryAnnotationSample> = {}): SummaryAnnotationSample {
  return {
    sampleIdentifier: "sample-1",
    claimText: "构建耗时 12 秒",
    evidenceText: "构建日志：耗时 12 秒",
    label: "supported",
    annotatorKind: "human",
    annotatorIdentifier: "reviewer-1",
    ...overrides,
  };
}

describe("SUM-02-04 人工标注评估", () => {
  it("① 全部人工标注且充足 ⇒ evaluated，分母显式", () => {
    const samples = Array.from({ length: 30 }, (_value, index) =>
      sample({ sampleIdentifier: `s-${String(index)}`, label: index < 20 ? "supported" : "missing" }),
    );
    const evaluation = evaluateSummaryAnnotations({ samples });
    expect(evaluation.conclusion).toBe("evaluated");
    expect(evaluation.usableSampleCount).toBe(30);
    expect(evaluation.precisionNumerator).toBe(20);
    expect(evaluation.precisionDenominator).toBe(30);
    expect(evaluation.precision).toBeCloseTo(20 / 30);
  });

  it("② 出现模型标注 ⇒ **整份评估不成立**（不参与计数）", () => {
    const evaluation = evaluateSummaryAnnotations({
      samples: [sample({ sampleIdentifier: "human-1" }), sample({ sampleIdentifier: "model-1", annotatorKind: "model" })],
    });
    expect(evaluation.conclusion).toBe("rejected-model-self-annotation");
    expect(evaluation.isModelSelfAnnotated).toBe(true);
    expect(evaluation.usableSampleCount).toBe(1);
    expect(evaluation.rejectedSamples[0]?.reasonCode).toBe("non-human-annotator");
  });

  it("③ 样本不足 ⇒ insufficient-sample，仍给分母但不得宣称改善", () => {
    const evaluation = evaluateSummaryAnnotations({
      samples: [sample({ sampleIdentifier: "s-1" }), sample({ sampleIdentifier: "s-2", label: "partialy" as never })],
    });
    expect(evaluation.conclusion).toBe("insufficient-sample");
    expect(evaluation.isSampleSizeSufficient).toBe(false);
    expect(evaluation.precisionDenominator).toBe(1);
    expect(evaluation.notice).toContain("不得");
    expect(DEFAULT_MINIMUM_ANNOTATION_SAMPLE_COUNT).toBe(30);
  });

  it("④ 重复 sampleIdentifier ⇒ 只计首次", () => {
    const evaluation = evaluateSummaryAnnotations({
      samples: [sample({ sampleIdentifier: "dup" }), sample({ sampleIdentifier: "dup", label: "missing" })],
    });
    expect(evaluation.usableSampleCount).toBe(1);
    expect(evaluation.labelCounts.supported).toBe(1);
    expect(evaluation.rejectedSamples[0]?.reasonCode).toBe("duplicate-sample");
  });

  it("⑤ 空声明 / 非法标签 ⇒ 各自拒绝（不静默计入）", () => {
    const evaluation = evaluateSummaryAnnotations({
      samples: [
        sample({ sampleIdentifier: "empty", claimText: "   " }),
        sample({ sampleIdentifier: "bad-label", label: "great" as never }),
        sample({ sampleIdentifier: "good" }),
      ],
    });
    expect(evaluation.usableSampleCount).toBe(1);
    const reasonCodes = evaluation.rejectedSamples.map((entry) => entry.reasonCode);
    expect(reasonCodes).toContain("empty-claim");
    expect(reasonCodes).toContain("invalid-label");
  });

  it("⑥ 四类标签各自计数；recall 分母与 numerator 正确", () => {
    const evaluation = evaluateSummaryAnnotations({
      samples: [
        sample({ sampleIdentifier: "a", label: "supported" }),
        sample({ sampleIdentifier: "b", label: "partially-supported" }),
        sample({ sampleIdentifier: "c", label: "missing" }),
        sample({ sampleIdentifier: "d", label: "misattributed" }),
      ],
    });
    expect(evaluation.labelCounts).toEqual({
      supported: 1,
      "partially-supported": 1,
      missing: 1,
      misattributed: 1,
    });
    expect(evaluation.recallNumerator).toBe(2);
    expect(evaluation.recallDenominator).toBe(4);
    expect(evaluation.recall).toBeCloseTo(0.5);
  });

  it("⑦ 无可用样本 ⇒ 指标为 null（不返回 0 冒充完全失败）", () => {
    const evaluation = evaluateSummaryAnnotations({ samples: [] });
    expect(evaluation.precision).toBeNull();
    expect(evaluation.recall).toBeNull();
    expect(evaluation.conclusion).toBe("insufficient-sample");
  });

  it("⑧ 误归因不计入 recall 的分子（错误归因不能算“部分支持”）", () => {
    const evaluation = evaluateSummaryAnnotations({
      samples: [
        sample({ sampleIdentifier: "a", label: "misattributed" }),
        sample({ sampleIdentifier: "b", label: "supported" }),
      ],
      minimumRequiredSampleCount: 1,
    });
    expect(evaluation.recallNumerator).toBe(1);
    expect(evaluation.recall).toBeCloseTo(0.5);
  });
});
