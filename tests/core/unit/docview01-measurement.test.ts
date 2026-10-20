/**
 * DOCVIEW-01-03 计量与语义覆盖的反例（2026-10-20）。
 *
 * 重点防三件事：**只报保留数**（自证清白）、**把估算说成真 token**、**长度下降当成准确性提升**。
 */
import { describe, expect, it } from "vitest";

import { extractDocumentBlocks } from "../../../packages/core/src/orchestration/document-view-adapter.js";
import { measureDocumentExtraction } from "../../../packages/core/src/orchestration/document-view-measurement.js";

function measure(fileName: string, content: string, measurementDurationMilliseconds?: number) {
  const extraction = extractDocumentBlocks({ fileName, content });
  return measureDocumentExtraction({
    fileName,
    content,
    extraction,
    ...(measurementDurationMilliseconds === undefined ? {} : { measurementDurationMilliseconds }),
  });
}

describe("DOCVIEW-01-03 计量", () => {
  it("① 同时给出原文字节与提取后字节（不只看后者）", () => {
    const content = "# 标题\n\n一段正文。";
    const result = measure("a.md", content);
    expect(result.sourceBytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.extractedBytes).toBeGreaterThan(0);
    // 提取结果通常更小（去掉了标记），但这**不等于**更准确
    expect(result.sourceBytes).toBeGreaterThanOrEqual(result.extractedBytes);
  });

  it("② token 一律标注为**估算**，不冒充真 tokenizer", () => {
    const result = measure("a.md", "abcdefgh");
    expect(result.tokenEstimateBasis).toBe("characters/4-estimate");
    expect(result.tokenEstimate).toBe(2);
  });

  it("③ 语义覆盖同时给出 expected 与 preserved（表格单元格）", () => {
    const content = ["| 名 | 值 |", "| --- | --- |", "| a | 1 |"].join("\n");
    const result = measure("t.md", content);
    const tableCoverage = result.coverage.find((entry) => entry.category === "table-cells");
    expect(tableCoverage?.expectedCount).toBe(4); // 表头 2 格 + 数据 2 格（分隔行不计）
    expect(tableCoverage?.preservedCount).toBe(4);
    expect(result.isSemanticCoverageComplete).toBe(true);
  });

  it("④ 标题/脚注/公式/修订/隐藏内容各自的覆盖都可核对", () => {
    const content = [
      "# 一级",
      "## 二级",
      "",
      "见脚注[^1]。",
      "[^1]: 脚注内容",
      "",
      "$$",
      "E=mc^2",
      "$$",
      "",
      "价格 ~~100~~ 改为 80。",
      "<!-- 隐藏备注 -->",
    ].join("\n");
    const result = measure("rich.md", content);
    const byCategory = new Map(result.coverage.map((entry) => [entry.category, entry]));
    expect(byCategory.get("headings")?.expectedCount).toBe(2);
    expect(byCategory.get("headings")?.preservedCount).toBe(2);
    expect(byCategory.get("footnotes")?.expectedCount).toBe(1);
    expect(byCategory.get("formulas")?.expectedCount).toBe(1); // `$$` 成对 ⇒ 1 个公式
    expect(byCategory.get("revisions")?.expectedCount).toBe(1);
    expect(byCategory.get("hidden-content")?.expectedCount).toBe(1);
    expect(result.isSemanticCoverageComplete).toBe(true);
  });

  it("⑤ 原文没有某类内容 ⇒ 视为已覆盖（不因 0 计数而假红）", () => {
    const result = measure("plain.txt", "只有一段文本。");
    expect(result.coverage.every((entry) => entry.isComplete)).toBe(true);
    expect(result.isSemanticCoverageComplete).toBe(true);
  });

  it("⑥ 覆盖不完整时整体 isSemanticCoverageComplete=false（不四舍五入）", () => {
    // 构造一个"表格块被当段落"的抽取结果（模拟降级/丢结构）
    const extraction = extractDocumentBlocks({
      fileName: "t.md",
      content: ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    });
    const tampered = {
      ...extraction,
      blocks: extraction.blocks.map((block) => ({ ...block, kind: "paragraph" as const })),
    };
    const result = measureDocumentExtraction({
      fileName: "t.md",
      content: ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
      extraction: tampered,
    });
    const tableCoverage = result.coverage.find((entry) => entry.category === "table-cells");
    expect(tableCoverage?.isComplete).toBe(false);
    expect(result.isSemanticCoverageComplete).toBe(false);
  });

  it("⑦ 支持 html：表格单元格按标签计数", () => {
    const content = "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>";
    const result = measure("t.html", content);
    const tableCoverage = result.coverage.find((entry) => entry.category === "table-cells");
    expect(tableCoverage?.expectedCount).toBe(4);
    expect(tableCoverage?.preservedCount).toBe(4);
  });

  it("⑧ 降级块数量、已知损失数量、截断标记都如实暴露", () => {
    const content = ["| a |", "| --- |", "| 1 |", "~~旧~~"].join("\n");
    const result = measure("x.md", content);
    expect(result.degradedBlockCount).toBeGreaterThanOrEqual(2);
    expect(result.knownLossCount).toBeGreaterThanOrEqual(0);
    expect(result.isTruncated).toBe(false);
  });

  it("⑨ 耗时未提供时为 null（不编造测量值）", () => {
    expect(measure("a.md", "x").measurementDurationMilliseconds).toBeNull();
  });

  it("⑩ 提供耗时时原样回传（不四舍五入/不换算）", () => {
    const result = measure("a.md", "x", 12.5);
    expect(result.measurementDurationMilliseconds).toBe(12.5);
  });

  it("⑪ 损坏/不支持也要能计量（kind 如实，覆盖为空但 complete=true）", () => {
    const broken = measure("b.md", "# 标题\u0000正文");
    expect(broken.kind).toBe("corrupted");
    expect(broken.blockCount).toBe(0);
    // 没有提取 ⇒ 没有可保留内容；expected 仍来自原文，故 heading 覆盖为 false
    expect(broken.isSemanticCoverageComplete).toBe(false);

    const unsupported = measure("c.docx", "PK\u0003\u0004");
    expect(unsupported.kind).toBe("unsupported");
    expect(unsupported.format).toBeNull();
  });

  it("⑫ 块数与降级数与抽取结果一致（计量不自己发明数字）", () => {
    const content = ["# 标题", "", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const extraction = extractDocumentBlocks({ fileName: "m.md", content });
    const result = measure("m.md", content);
    expect(result.blockCount).toBe(extraction.blocks.length);
    expect(result.degradedBlockCount).toBe(
      extraction.blocks.filter((block) => block.isDegraded).length,
    );
  });

  it("⑬ 截断必须如实暴露（不把'读一半'说成读完）", () => {
    // 超过块数上限 ⇒ 抽取阶段标 isTruncated，计量必须原样带出
    const content = Array.from({ length: 2_100 }, (_value, index) => `- 第 ${String(index)} 行`).join("\n");
    const result = measure("big.md", content);
    expect(result.isTruncated).toBe(true);
    expect(result.blockCount).toBeLessThanOrEqual(2_000);
  });
});


