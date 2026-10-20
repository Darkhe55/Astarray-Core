/**
 * DOCVIEW-01-02 的反例（2026-10-20）。
 *
 * 每一条都对应卡内点名的一个风险：表格/脚注/修订/公式/隐藏内容**不得静默丢失**、
 * 转义要解码、损坏文件不得半真半假、不支持格式不得伪报、块要有**定位回执**、写回恒禁止。
 */
import { describe, expect, it } from "vitest";

import {
  MAXIMUM_DOCUMENT_BLOCKS,
  detectFirstBatchDocumentFormat,
  extractDocumentBlocks,
} from "../../../packages/core/src/orchestration/document-view-adapter.js";

describe("DOCVIEW-01-02 首批适配器", () => {
  it("① 扩展名识别：md/html/txt 支持，docx/pdf 明确不在首批", () => {
    expect(detectFirstBatchDocumentFormat("README.md")).toBe("markdown");
    expect(detectFirstBatchDocumentFormat("page.HTM")).toBe("html");
    expect(detectFirstBatchDocumentFormat("notes.txt")).toBe("text");
    expect(detectFirstBatchDocumentFormat("report.docx")).toBeNull();
    expect(detectFirstBatchDocumentFormat("paper.pdf")).toBeNull();
  });

  it("② 不支持格式 ⇒ unsupported 且**不给假块**", () => {
    const result = extractDocumentBlocks({ fileName: "report.docx", content: "PK\u0003\u0004binary" });
    expect(result.kind).toBe("unsupported");
    expect(result.blocks).toHaveLength(0);
    expect(result.knownLosses.join()).toContain("首批适配器只覆盖");
  });

  it("③ 损坏文件（NUL 字节）⇒ corrupted，不返回正文", () => {
    const result = extractDocumentBlocks({ fileName: "broken.md", content: "# 标题\u0000正文" });
    expect(result.kind).toBe("corrupted");
    expect(result.blocks).toHaveLength(0);
    expect(result.knownLosses.join()).toContain("NUL");
  });

  it("④ 编码失真（大量 U+FFFD）⇒ corrupted，不猜内容", () => {
    const result = extractDocumentBlocks({
      fileName: "gbk.md",
      content: "\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD",
    });
    expect(result.kind).toBe("corrupted");
  });

  it("⑤ 表格：保留为块并标降级（不静默丢列关系）", () => {
    const content = ["| 名称 | 值 |", "| --- | --- |", "| a | 1 |", "| b | 2 |"].join("\n");
    const result = extractDocumentBlocks({ fileName: "table.md", content });
    const tableBlock = result.blocks.find((block) => block.kind === "table");
    expect(tableBlock).toBeDefined();
    expect(tableBlock?.isDegraded).toBe(true);
    expect(tableBlock?.degradationReason).toContain("列合并");
    expect(tableBlock?.text).toContain("| a | 1 |");
    expect(tableBlock?.lineStart).toBe(1);
    expect(tableBlock?.lineEnd).toBe(4);
  });

  it("⑥ 脚注：定义独立成块并标降级（不臆造正文关联）", () => {
    const content = ["正文见脚注[^1]。", "", "[^1]: 脚注内容。"].join("\n");
    const result = extractDocumentBlocks({ fileName: "footnote.md", content });
    const footnoteBlock = result.blocks.find((block) => block.kind === "footnote");
    expect(footnoteBlock?.text).toContain("脚注内容");
    expect(footnoteBlock?.isDegraded).toBe(true);
  });

  it("⑦ 公式：原文保留、标降级与不确定（不渲染、不执行宏）", () => {
    const content = ["$$", "E = mc^2", "$$"].join("\n");
    const result = extractDocumentBlocks({ fileName: "formula.md", content });
    const formulaBlock = result.blocks.find((block) => block.kind === "formula");
    expect(formulaBlock?.text).toContain("E = mc^2");
    expect(formulaBlock?.isDegraded).toBe(true);
    expect(formulaBlock?.mustMarkUncertain).toBe(true);
    expect(result.executesMacrosOrScripts).toBe(false);
  });

  it("⑧ 修订（删除线）保留语义提示并标不确定", () => {
    const result = extractDocumentBlocks({ fileName: "revision.md", content: "价格 ~~100~~ 改为 80。" });
    const revisionBlock = result.blocks.find((block) => block.kind === "revision");
    expect(revisionBlock?.text).toContain("~~100~~");
    expect(revisionBlock?.mustMarkUncertain).toBe(true);
  });

  it("⑨ 隐藏内容（HTML 注释）计入块与损失说明（不静默丢弃）", () => {
    const result = extractDocumentBlocks({
      fileName: "hidden.md",
      content: ["<!-- 内部备注：勿外发 -->", "正文"].join("\n"),
    });
    const hiddenBlock = result.blocks.find((block) => block.kind === "hidden-content");
    expect(hiddenBlock?.text).toContain("内部备注");
    expect(hiddenBlock?.isDegraded).toBe(true);
  });

  it("⑩ HTML 实体转义被解码（但不执行标签）", () => {
    const result = extractDocumentBlocks({
      fileName: "escape.html",
      content: "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    });
    const paragraph = result.blocks[0];
    expect(paragraph?.text).toContain("<script>alert(1)</script>");
    expect(result.executesMacrosOrScripts).toBe(false);
  });

  it("⑪ HTML 表格与删除线：结构检测为独立块并降级", () => {
    const content = "<table><tr><th>名</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table><p>行</p><del>旧值</del>";
    const result = extractDocumentBlocks({ fileName: "t.html", content });
    expect(result.blocks.some((block) => block.kind === "table")).toBe(true);
    const revision = result.blocks.find((block) => block.kind === "revision");
    expect(revision?.text).toContain("[删除]");
  });

  it("⑫ 每块都有**稳定锚点**与阅读顺序（定位回执）", () => {
    const content = ["# 标题", "", "第一段。", "", "第二段。"].join("\n");
    const result = extractDocumentBlocks({ fileName: "anchors.md", content });
    expect(result.blocks.length).toBeGreaterThanOrEqual(3);
    expect(result.blocks.map((block) => block.ordinal)).toEqual(
      result.blocks.map((_block, index) => index + 1),
    );
    for (const block of result.blocks) {
      expect(block.sourceAnchor).toMatch(/^markdown:line:\d+$/);
    }
    // 源版本必须标注（读的是哪一版）
    expect(result.sourceRevision).toMatch(/^[0-9a-f]{64}$/);
    // 过滤视图不得写回
    expect(result.isFullFileWriteBackAllowed).toBe(false);
  });

  it("⑬ 空文件 ⇒ extracted 且明确说明“不是读取失败”", () => {
    const result = extractDocumentBlocks({ fileName: "empty.txt", content: "\n   \n" });
    expect(result.kind).toBe("extracted");
    expect(result.blocks).toHaveLength(0);
    expect(result.knownLosses.join()).toContain("文件为空");
  });

  it("⑭ 块数有界：超过上限标 isTruncated（防资源耗尽）", () => {
    const content = Array.from({ length: MAXIMUM_DOCUMENT_BLOCKS + 50 }, (_value, index) => `- 第 ${String(index)} 行`).join("\n");
    const result = extractDocumentBlocks({ fileName: "big.md", content });
    expect(result.isTruncated).toBe(true);
    expect(result.blocks.length).toBeLessThanOrEqual(MAXIMUM_DOCUMENT_BLOCKS);
  });

  it("⑮ 代码围栏未闭合 ⇒ 块标降级并给出损失说明", () => {
    const content = ["```ts", "const a = 1;"].join("\n");
    const result = extractDocumentBlocks({ fileName: "fence.md", content });
    const codeBlock = result.blocks.find((block) => block.kind === "code-block");
    expect(codeBlock?.isDegraded).toBe(true);
    expect(result.knownLosses.join()).toContain("未闭合");
  });

  it("⑯ CRLF 行尾不影响定位（行号按逻辑行计）", () => {
    const result = extractDocumentBlocks({ fileName: "crlf.md", content: "# 标题\r\n\r\n正文" });
    expect(result.blocks[0]?.lineStart).toBe(1);
    expect(result.blocks[1]?.lineStart).toBe(3);
  });
});
