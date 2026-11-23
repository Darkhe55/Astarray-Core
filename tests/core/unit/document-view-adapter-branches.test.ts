/**
 * B9（2026-11-24）：文档视图适配器的格式识别、损坏拒绝与有界截断分支。
 *
 * 纪律：不支持/损坏/空文件都必须**明确分类**（不伪装成"已读取"）；
 * 截断必须可见（`isTruncated` + `knownLosses`），单块降级要标记不确定。
 */
import { describe, expect, it } from "vitest";

import {
  MAXIMUM_DOCUMENT_BLOCKS,
  MAXIMUM_DOCUMENT_BLOCK_CHARACTERS,
  detectFirstBatchDocumentFormat,
  extractDocumentBlocks,
} from "../../../packages/core/src/orchestration/document-view-adapter.js";

describe("B9：文档格式识别", () => {
  it("① 扩展名大小写不敏感，六种已知扩展名各自映射", () => {
    expect(detectFirstBatchDocumentFormat("A.MD")).toBe("markdown");
    expect(detectFirstBatchDocumentFormat("a.markdown")).toBe("markdown");
    expect(detectFirstBatchDocumentFormat("a.HTML")).toBe("html");
    expect(detectFirstBatchDocumentFormat("a.htm")).toBe("html");
    expect(detectFirstBatchDocumentFormat("a.TXT")).toBe("text");
    expect(detectFirstBatchDocumentFormat("a.text")).toBe("text");
  });

  it("② 未知扩展名 ⇒ null（由调用方报不支持）", () => {
    expect(detectFirstBatchDocumentFormat("a.pdf")).toBeNull();
    expect(detectFirstBatchDocumentFormat("a")).toBeNull();
    expect(detectFirstBatchDocumentFormat("a.docx")).toBeNull();
  });
});

describe("B9：文档块提取的分类与边界", () => {
  it("③ 不支持的格式 ⇒ unsupported（不给正文、不可整体写回）", () => {
    const result = extractDocumentBlocks({ fileName: "a.pdf", content: "x" });
    expect(result.kind).toBe("unsupported");
    expect(result.format).toBeNull();
    expect(result.blocks).toHaveLength(0);
    expect(result.knownLosses.length).toBeGreaterThan(0);
    expect(result.isFullFileWriteBackAllowed).toBe(false);
    expect(result.executesMacrosOrScripts).toBe(false);
  });

  it("④ 含 NUL 字节 ⇒ corrupted（拒绝给出可能失真的正文）", () => {
    const result = extractDocumentBlocks({ fileName: "a.txt", content: "abc\u0000def" });
    expect(result.kind).toBe("corrupted");
    expect(result.format).toBe("text");
    expect(result.blocks).toHaveLength(0);
    expect(result.knownLosses[0]).toContain("NUL");
  });

  it("⑤ 替换字符占比过高 ⇒ corrupted", () => {
    const content = "\uFFFD".repeat(60);
    const result = extractDocumentBlocks({ fileName: "a.txt", content });
    expect(result.kind).toBe("corrupted");
    expect(result.knownLosses[0]).toContain("U+FFFD");
  });

  it("⑥ 空文件 ⇒ extracted 但零块，并说明这不是读取失败", () => {
    const result = extractDocumentBlocks({ fileName: "a.txt", content: "  \n\t\n" });
    expect(result.kind).toBe("extracted");
    expect(result.blocks).toHaveLength(0);
    expect(result.isTruncated).toBe(false);
    expect(result.knownLosses.join("")).toContain("文件为空");
  });

  it("⑦ 文本：跳过空行，块带序号/行号/稳定锚点", () => {
    const result = extractDocumentBlocks({ fileName: "a.txt", content: "第一行\n\n  第二行  " });
    expect(result.kind).toBe("extracted");
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toMatchObject({
      blockIdentifier: "text-block-1",
      kind: "paragraph",
      ordinal: 1,
      lineStart: 1,
      sourceAnchor: "text:line:1",
    });
    expect(result.blocks[1]).toMatchObject({ ordinal: 2, lineStart: 3 });
  });

  it("⑧ 单块超上限 ⇒ 截断 + 降级标记 + knownLosses 说明", () => {
    const longLine = "é".repeat(MAXIMUM_DOCUMENT_BLOCK_CHARACTERS + 1);
    const result = extractDocumentBlocks({ fileName: "a.txt", content: longLine });
    expect(result.isTruncated).toBe(true);
    expect(result.blocks[0]?.isDegraded).toBe(true);
    expect(result.blocks[0]?.mustMarkUncertain).toBe(true);
    expect(result.blocks[0]?.text.length).toBe(MAXIMUM_DOCUMENT_BLOCK_CHARACTERS + 1);
    expect(result.knownLosses.join("")).toContain("内容被截断");
  });

  it("⑨ 块数超上限 ⇒ 只保留上限数量并标记截断", () => {
    const content = Array.from(
      { length: MAXIMUM_DOCUMENT_BLOCKS + 5 },
      (_unused, index) => `第 ${String(index + 1)} 行`,
    ).join("\n");
    const result = extractDocumentBlocks({ fileName: "a.txt", content });
    expect(result.blocks).toHaveLength(MAXIMUM_DOCUMENT_BLOCKS);
    expect(result.isTruncated).toBe(true);
  });

  it("⑩ markdown：标题识别为 heading；连续正文为 paragraph", () => {
    const result = extractDocumentBlocks({
      fileName: "a.md",
      content: "# 标题\n\n正文第一段\n\n正文第二段",
    });
    expect(result.format).toBe("markdown");
    const kinds = result.blocks.map((block) => block.kind);
    expect(kinds[0]).toBe("heading");
    expect(kinds).toContain("paragraph");
  });

  it("⑪ html：实体解码后不执行标记（只取文本）", () => {
    const result = extractDocumentBlocks({
      fileName: "a.html",
      content: "<h1>标题 &amp; 说明</h1><p>第一段</p>",
    });
    expect(result.format).toBe("html");
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.some((block) => block.text.includes("&"))).toBe(true);
    expect(result.executesMacrosOrScripts).toBe(false);
  });
});
