/**
 * SUM-02-01/02 反例（2026-10-22）。
 *
 * 覆盖：来源 schema 区分、未知时保守估算、不宣称准确 token、不联网、
 * 只选完整记录、不裁剪存档、4096 规则、放不下 blocked/拆分、模型切换重新计量。
 */
import { describe, expect, it } from "vitest";

import {
  measureSummaryText,
  planSummarySelection,
  remeasureAfterModelSwitch,
  type SummaryArchiveRecord,
  type SummaryMeteringSource,
  type SummaryTokenizerPort,
} from "../../../packages/core/src/summarization/summary-token-budget.js";

const source: SummaryMeteringSource = {
  providerIdentifier: "provider-a",
  modelIdentifier: "model-a",
  modelVersionIdentifier: "2026-10",
  tokenizerIdentifier: "tok-a",
  serializationVersion: "chat-v1",
};

const tokenizer: SummaryTokenizerPort = {
  tokenizerIdentifier: "tok-a",
  serializationVersion: "chat-v1",
  countTokens: (text) => text.length,
};

function record(overrides: Partial<SummaryArchiveRecord> = {}): SummaryArchiveRecord {
  return {
    recordIdentifier: "record-1",
    chunkIdentifier: "chunk-1",
    text: "abcdefghij", // 10 字符：tokenizer 计量 10；估算上界 5
    ...overrides,
  };
}

describe("SUM-02-01 计量适配端口", () => {
  it("① 注入匹配的 tokenizer ⇒ measured（basis=tokenizer）", () => {
    const measurement = measureSummaryText({ text: "abcdefghij", source, tokenizer });
    expect(measurement).toMatchObject({ kind: "measured", tokenCount: 10, basis: "tokenizer" });
  });

  it("② 无 tokenizer ⇒ 保守上界估算，且**不宣称准确**", () => {
    const measurement = measureSummaryText({ text: "abcdefghij", source, tokenizer: null });
    expect(measurement.kind).toBe("estimated");
    if (measurement.kind !== "estimated") throw new Error("unreachable");
    expect(measurement.isConservativeUpperBound).toBe(true);
    expect(measurement.estimationRule).toContain("不宣称准确");
    expect(measurement.tokenCount).toBe(5); // ceil(10/2)
  });

  it("③ tokenizer 与来源 schema 不一致 ⇒ 降级为估算（不混用）", () => {
    const mismatched: SummaryTokenizerPort = { ...tokenizer, tokenizerIdentifier: "tok-b" };
    const measurement = measureSummaryText({ text: "abcdefghij", source, tokenizer: mismatched });
    expect(measurement.kind).toBe("estimated");
    if (measurement.kind !== "estimated") throw new Error("unreachable");
    expect(measurement.estimationRule).toContain("不一致");
  });

  it("④ 中英文/emoji/代码/数学单位样本：估算规则稳定且有上界", () => {
    const samples = ["中文摘要内容", "emoji 🚀🚀 测试", "const a = 1;", "12.5 kg/m² ≈ 0.0125 t/m²"];
    for (const text of samples) {
      const measurement = measureSummaryText({ text, source, tokenizer: null });
      expect(measurement.kind).toBe("estimated");
      expect(measurement.tokenCount).toBe(Math.ceil(text.length / 2));
    }
  });

  it("⑤ 计量只依赖注入端口，**不做联网**（端口缺失不抛错、不等待）", () => {
    expect(() => measureSummaryText({ text: "abc", source })).not.toThrow();
  });
});

describe("SUM-02-02 选入规划（不裁剪存档）", () => {
  it("⑥ 只选完整记录，且**输入数组未被修改**（不裁剪存档）", () => {
    const records = [
      record({ recordIdentifier: "a", text: "x".repeat(100) }),
      record({ recordIdentifier: "b", text: "y".repeat(100) }),
      record({ recordIdentifier: "c", text: "z".repeat(100) }),
    ];
    const snapshot = JSON.stringify(records);
    const plan = planSummarySelection({
      records,
      inputTokenBudget: 4096,
      outputTokenReservation: 512,
      source,
      tokenizer: null,
    });
    expect(plan.kind).toBe("selected");
    expect(JSON.stringify(records)).toBe(snapshot);
    if (plan.kind !== "selected") throw new Error("unreachable");
    // 每条估算 50 tokens，3584 可用 ⇒ 全选
    expect(plan.selectedRecords.map((entry) => entry.recordIdentifier)).toEqual(["a", "b", "c"]);
    expect(plan.usedInputTokenCount).toBe(150);
  });

  it("⑦ 放不下 ⇒ 只选能完整放下的（不切半条）", () => {
    const records = Array.from({ length: 5 }, (_value, index) =>
      record({ recordIdentifier: `r-${String(index)}`, text: "x".repeat(1_000) }),
    );
    const plan = planSummarySelection({
      records,
      inputTokenBudget: 1_200,
      outputTokenReservation: 200,
      source,
      tokenizer: null,
    });
    expect(plan.kind).toBe("selected");
    if (plan.kind !== "selected") throw new Error("unreachable");
    // 可用 1000，每条估算 500 ⇒ 只能放 2 条
    expect(plan.selectedRecords).toHaveLength(2);
    expect(plan.usedInputTokenCount).toBe(1_000);
    // 关键：选入的记录必须是**完整原文**（不得截断后塞入）
    expect(plan.selectedRecords.every((entry) => entry.text.length === 1_000)).toBe(true);
  });

  it("⑧ 预算小于输出预留 ⇒ blocked（不静默裁剪）", () => {
    const plan = planSummarySelection({
      records: [record()],
      inputTokenBudget: 400,
      outputTokenReservation: 512,
      source,
      tokenizer: null,
    });
    expect(plan).toMatchObject({ kind: "blocked", reasonCode: "budget-too-small-for-pinned-records" });
  });

  it("⑨ 单条 pinned 记录超预算 ⇒ blocked（不截断记录）", () => {
    const plan = planSummarySelection({
      records: [record({ isPinned: true, text: "x".repeat(10_000) })],
      inputTokenBudget: 1_000,
      outputTokenReservation: 100,
      source,
      tokenizer: null,
    });
    expect(plan).toMatchObject({ kind: "blocked", reasonCode: "single-record-exceeds-budget" });
    if (plan.kind !== "blocked") throw new Error("unreachable");
    expect(plan.reason).toContain("不截断记录");
  });

  it("⑩ 没有可完整放入的记录 ⇒ split-plan（建议拆页，不硬塞）", () => {
    const plan = planSummarySelection({
      records: [record({ text: "x".repeat(2_000) })],
      inputTokenBudget: 900,
      outputTokenReservation: 100,
      source,
      tokenizer: null,
    });
    expect(plan.kind).toBe("split-plan");
    if (plan.kind !== "split-plan") throw new Error("unreachable");
    expect(plan.pageSizeHint).toBeGreaterThanOrEqual(1);
  });

  it("⑪ 计划里标注计量口径（measured/estimated 混合时都列出）", () => {
    const plan = planSummarySelection({
      records: [record({ text: "abcd" }), record({ recordIdentifier: "r-2", text: "efgh" })],
      inputTokenBudget: 4096,
      outputTokenReservation: 0,
      source,
      tokenizer,
    });
    expect(plan.kind).toBe("selected");
    if (plan.kind !== "selected") throw new Error("unreachable");
    expect(plan.measurementBases).toEqual(["tokenizer"]);
  });

  it("⑫ 全局 4096 规则：预算由调用方给，函数不偷偷放大", () => {
    const plan = planSummarySelection({
      records: Array.from({ length: 20 }, (_value, index) =>
        record({ recordIdentifier: `r-${String(index)}`, text: "x".repeat(1_000) }),
      ),
      inputTokenBudget: 4_096,
      outputTokenReservation: 512,
      source,
      tokenizer: null,
    });
    expect(plan.kind).toBe("selected");
    if (plan.kind !== "selected") throw new Error("unreachable");
    expect(plan.totalTokenCount).toBeLessThanOrEqual(4_096);
  });

  it("⑬ 模型切换 ⇒ **重新计量**，且只重算本轮（历史不重写）", () => {
    const result = remeasureAfterModelSwitch({
      text: "abcdefghij",
      previousSource: source,
      nextSource: { ...source, modelIdentifier: "model-b" },
      tokenizer: null,
    });
    expect(result.isRemeasured).toBe(true);
    expect(result.notice).toContain("历史摘要与存档不重写");
  });

  it("⑭ 同一模型重复计量 ⇒ 不视为重新计量", () => {
    const result = remeasureAfterModelSwitch({
      text: "abcdefghij",
      previousSource: source,
      nextSource: { ...source },
      tokenizer: null,
    });
    expect(result.isRemeasured).toBe(false);
  });
});

