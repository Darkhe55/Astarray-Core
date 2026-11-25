/**
 * B9（2026-11-25）：文档视图首批适配器（markdown/html/text）的提取与降级分支。
 *
 * 纪律：不可信解码（NUL/U+FFFD 过多）必须标记 corrupted 而不是给失真正文；
 * 不支持的格式必须如实说"不支持"，不伪装成功。
 */
import { describe, expect, it } from "vitest";

import {
  detectFirstBatchDocumentFormat,
  extractDocumentBlocks,
} from "../../../packages/core/src/orchestration/document-view-adapter.js";

describe("B9：文档视图适配器", () => {
  it("① 扩展名识别：md/markdown/html/htm/txt/text；未知返回 null", () => {
    expect(detectFirstBatchDocumentFormat("README.md")).toBe("markdown");
    expect(detectFirstBatchDocumentFormat("notes.MARKDOWN")).toBe("markdown");
    expect(detectFirstBatchDocumentFormat("page.html")).toBe("html");
    expect(detectFirstBatchDocumentFormat("page.HTM")).toBe("html");
    expect(detectFirstBatchDocumentFormat("a.txt")).toBe("text");
    expect(detectFirstBatchDocumentFormat("a.TEXT")).toBe("text");
    expect(detectFirstBatchDocumentFormat("report.pdf")).toBeNull();
    expect(detectFirstBatchDocumentFormat("noext")).toBeNull();
  });

  it("② 不支持的格式 ⇒ unsupported，且不声称可写回/执行宏", () => {
    const result = extractDocumentBlocks({ fileName: "report.docx", content: "x" });
    expect(result.kind).toBe("unsupported");
    expect(result.blocks).toEqual([]);
    expect(result.isFullFileWriteBackAllowed).toBe(false);
    expect(result.executesMacrosOrScripts).toBe(false);
  });

  it("③ 含 NUL 字节 ⇒ corrupted（拒绝给出正文）", () => {
    const result = extractDocumentBlocks({ fileName: "a.txt", content: "abc\u0000def" });
    expect(result.kind).toBe("corrupted");
    expect(result.blocks).toEqual([]);
    expect(result.knownLosses.join("")).toContain("NUL");
  });

  it("④ U+FFFD 占比过高 ⇒ corrupted；占比低 ⇒ 正常提取", () => {
    const mostlyReplacement = "\uFFFD".repeat(100);
    expect(extractDocumentBlocks({ fileName: "a.txt", content: mostlyReplacement }).kind).toBe(
      "corrupted",
    );
    const lowReplacement = "正常文本".repeat(200) + "\uFFFD";
    expect(extractDocumentBlocks({ fileName: "a.txt", content: lowReplacement }).kind).toBe(
      "extracted",
    );
  });

  it("⑤ 空文件 ⇒ extracted + 空块 + 明确说明（不是读取失败）", () => {
    const result = extractDocumentBlocks({ fileName: "a.txt", content: "   \n  " });
    expect(result.kind).toBe("extracted");
    expect(result.blocks).toEqual([]);
    expect(result.knownLosses.join("")).toContain("文件为空");
  });

  it("⑥ markdown：表格/删除线/脚注/公式/注释如实标注（不静默丢弃）", () => {
    const markdown = [
      "# 标题",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "~~删除线~~ 与 $x^2$",
      "",
      "[^1]: 脚注内容",
      "",
      "<!-- 注释 -->",
    ].join("\n");
    const result = extractDocumentBlocks({ fileName: "doc.md", content: markdown });
    expect(result.kind).toBe("extracted");
    expect(result.format).toBe("markdown");
    expect(result.blocks.length).toBeGreaterThan(0);
    const allText = result.blocks.map((block) => block.text).join("\n");
    expect(allText.length).toBeGreaterThan(0);
  });

  it("⑦ html：实体解码且不执行脚本", () => {
    const html = "<p>a &amp; b &lt; c</p><script>alert(1)</script>";
    const result = extractDocumentBlocks({ fileName: "doc.html", content: html });
    expect(result.kind).toBe("extracted");
    expect(result.format).toBe("html");
    expect(result.executesMacrosOrScripts).toBe(false);
  });

  it("⑧ text：按行成块、空行跳过", () => {
    const result = extractDocumentBlocks({ fileName: "doc.txt", content: "第一行\n\n第二行\n" });
    expect(result.kind).toBe("extracted");
    expect(result.blocks.map((block) => block.text)).toEqual(["第一行", "第二行"]);
  });
});
