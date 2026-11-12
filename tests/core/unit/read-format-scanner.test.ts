/**
 * 语言感知读取视图扫描器（此前 `tests/` 零引用）。
 *
 * 契约要点：**不修改源文件**、字符串里的注释标记不误删、省略时补回换行保证行号对齐、
 * 未闭合结构 ⇒ `parse-error` 并**原样返回全文**。
 */
import { describe, expect, it } from "vitest";

import {
  computeSourceHash,
  consumeBlockComment,
  consumeQuotedString,
  extensionOf,
  scanReadView,
} from "../../../packages/core/src/tools/read-format/read-format-scanner.js";
import type { ReadFormatScanProfile } from "../../../packages/core/src/tools/read-format/read-format-scanner.js";

function buildProfile(): ReadFormatScanProfile {
  return {
    strategyId: "test-js-like",
    policyVersion: 1,
    lineCommentTokens: ["//"],
    blockComment: { start: "/*", end: "*/", nested: false },
    scanString: (sourceText, index) =>
      sourceText[index] === '"'
        ? consumeQuotedString({ sourceText, startIndex: index, quote: '"', supportsEscapes: true })
        : null,
    matchImportStatement: () => null,
  };
}

function countLines(text: string): number {
  if (text === "") return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

const SOURCE = ['const a = 1;', '// 这是一行注释', 'const b = "http://example.com/x";', "function f() { return b; }"].join("\n") + "\n";

describe("读取视图扫描", () => {
  it("① 不过滤 ⇒ 原样返回、not-filtered、lineMap 覆盖全部行", () => {
    const result = scanReadView({
      profile: buildProfile(),
      sourceText: SOURCE,
      shouldIncludeComments: true,
      shouldIncludeImports: true,
    });
    expect(result.viewText).toBe(SOURCE);
    expect(result.filterStatus).toBe("not-filtered");
    expect(result.isViewComplete).toBe(true);
    expect(result.omittedKinds).toEqual([]);
    expect(result.lineMap).toEqual([
      { returnedStartLine: 1, sourceStartLine: 1, lineCount: countLines(SOURCE) },
    ]);
  });

  it("② 过滤注释 ⇒ 行数不变（空行补位）、标为 filtered、如实记录省略行", () => {
    const result = scanReadView({
      profile: buildProfile(),
      sourceText: SOURCE,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expect(result.filterStatus).toBe("filtered");
    expect(result.isViewComplete).toBe(false);
    expect(result.omittedKinds).toEqual(["comment"]);
    expect(result.viewText).not.toContain("这是一行注释");
    /** 行号对齐：返回视图与源文件行数一致。 */
    expect(countLines(result.viewText)).toBe(countLines(SOURCE));
    expect(result.omittedLineRanges.length).toBeGreaterThan(0);
    expect(result.omittedLineRanges[0]?.startLine).toBe(2);
  });

  it("③ 字符串里的 `//` 不会被当成注释删掉", () => {
    const result = scanReadView({
      profile: buildProfile(),
      sourceText: SOURCE,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expect(result.viewText).toContain('"http://example.com/x"');
  });

  it("④ 未闭合块注释 ⇒ parse-error 并**原样返回全文**（不输出半截视图）", () => {
    const broken = "const a = 1;\n/* 未闭合的注释\nconst b = 2;\n";
    const result = scanReadView({
      profile: buildProfile(),
      sourceText: broken,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expect(result.filterStatus).toBe("parse-error");
    expect(result.viewText).toBe(broken);
    expect(result.isViewComplete).toBe(false);
    expect(result.limitations.join("|")).toContain("parse-error");
  });
});

describe("底层扫描原语", () => {
  it("⑤ consumeBlockComment：闭合返回 endIndex，未闭合返回 null，支持嵌套", () => {
    expect(consumeBlockComment("/* abc */ rest", 0, { start: "/*", end: "*/", nested: false })).toEqual({
      endIndex: 9,
    });
    expect(consumeBlockComment("/* abc", 0, { start: "/*", end: "*/", nested: false })).toBeNull();
    expect(
      consumeBlockComment("/* a /* b */ c */ tail", 0, { start: "/*", end: "*/", nested: true }),
    ).toEqual({ endIndex: 17 });
  });

  it("⑥ consumeQuotedString：闭合、跨行未闭合、转义跳过", () => {
    expect(
      consumeQuotedString({ sourceText: '"abc" tail', startIndex: 0, quote: '"', supportsEscapes: true }),
    ).toEqual({ endIndex: 5, isUnterminated: false });
    expect(
      consumeQuotedString({ sourceText: '"abc\n', startIndex: 0, quote: '"', supportsEscapes: true }),
    ).toMatchObject({ isUnterminated: true });
    expect(
      consumeQuotedString({
        sourceText: '"a\\"b" tail',
        startIndex: 0,
        quote: '"',
        supportsEscapes: true,
      }),
    ).toEqual({ endIndex: 6, isUnterminated: false });
  });

  it("⑦ computeSourceHash 稳定且区分内容", () => {
    expect(computeSourceHash("abc")).toBe(computeSourceHash("abc"));
    expect(computeSourceHash("abc")).not.toBe(computeSourceHash("abd"));
    expect(computeSourceHash("abc")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("⑧ extensionOf：小写化、无扩展名与隐藏文件为空", () => {
    expect(extensionOf("a.ts")).toBe(".ts");
    expect(extensionOf("A.TS")).toBe(".ts");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
  });
});
