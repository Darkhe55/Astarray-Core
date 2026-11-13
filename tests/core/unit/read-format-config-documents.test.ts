/**
 * 配置/文档读取策略（此前 `tests/` 零引用）。
 *
 * 关键取舍：**能力不支持就如实标注**（JSON 无注释语义、这些格式无导入概念），
 * 围栏代码块整体保留，YAML 的 `#` 需位于行首/空白之后（URL 片段不误删）。
 */
import { describe, expect, it } from "vitest";

import {
  appendUnsupportedImportNotice,
  scanHashCommentDocumentView,
  scanJsonLikeView,
  scanMarkdownView,
  scanPlainTextView,
} from "../../../packages/core/src/tools/read-format/read-format-config-documents.js";

function countLines(text: string): number {
  if (text === "") return 0;
  const newlines = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

describe("JSON / JSONC", () => {
  it("① JSONC 过滤注释 ⇒ 注释消失、行数不变、标为 filtered", () => {
    const source = ['{', '  // 这是注释', '  "a": 1,', '  /* 块注释 */', '  "b": 2', '}', ""].join("\n");
    const result = scanJsonLikeView({
      sourceText: source,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
      hasComments: true,
      hasLineComments: true,
    });
    expect(result.filterStatus).toBe("filtered");
    expect(result.viewText).not.toContain("这是注释");
    expect(result.viewText).not.toContain("块注释");
    expect(result.viewText).toContain('"a": 1');
    expect(countLines(result.viewText)).toBe(countLines(source));
    expect(result.isViewComplete).toBe(false);
  });

  it("② 纯 JSON 没有注释语义 ⇒ **如实标注不支持**，不虚报已过滤", () => {
    const source = '{"a": 1}\n';
    const result = scanJsonLikeView({
      sourceText: source,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
      hasComments: false,
      hasLineComments: false,
    });
    expect(result.viewText).toBe(source);
    expect(result.filterStatus).toBe("not-filtered");
    expect(result.limitations.join("|")).toContain("comments-unsupported");
  });

  it("③ 导入能力不支持 ⇒ 标注 imports-unsupported（不适用，不是失败）", () => {
    const result = scanJsonLikeView({
      sourceText: '{"a": 1}\n',
      shouldIncludeComments: true,
      shouldIncludeImports: false,
      hasComments: true,
      hasLineComments: true,
    });
    expect(result.limitations.join("|")).toContain("imports-unsupported");
    expect(result.filterStatus).toBe("not-filtered");
  });
});

describe("YAML / TOML（# 注释）", () => {
  it("④ YAML：行首/空白后的 # 被过滤，但 URL 片段里的 # 不误删", () => {
    const source = ["# 顶部注释", "name: demo", "url: http://example.com/x#frag", "other: 1 # 行尾注释", ""].join("\n");
    const result = scanHashCommentDocumentView({
      sourceText: source,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
      isYaml: true,
    });
    expect(result.viewText).not.toContain("顶部注释");
    expect(result.viewText).toContain("http://example.com/x#frag");
    expect(countLines(result.viewText)).toBe(countLines(source));
  });

  it("⑤ TOML 同样按 # 过滤行注释", () => {
    const source = ["# 注释", 'title = "demo"', ""].join("\n");
    const result = scanHashCommentDocumentView({
      sourceText: source,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
      isYaml: false,
    });
    expect(result.viewText).not.toContain("注释");
    expect(result.viewText).toContain('title = "demo"');
    expect(result.filterStatus).toBe("filtered");
  });
});

describe("Markdown", () => {
  it("⑥ 围栏代码块内的 <!-- --> **整体保留**，块外注释被过滤", () => {
    const source = ["# 标题", "<!-- 隐藏说明 -->", "```", "<!-- 代码里的注释 -->", "```", "正文", ""].join("\n");
    const result = scanMarkdownView({
      sourceText: source,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expect(result.viewText).not.toContain("隐藏说明");
    expect(result.viewText).toContain("<!-- 代码里的注释 -->");
    expect(result.filterStatus).toBe("filtered");
    expect(countLines(result.viewText)).toBe(countLines(source));
    expect(result.omittedLineRanges[0]).toMatchObject({ kind: "comment", startLine: 2, endLine: 2 });
  });

  it("⑦ 未闭合的 <!-- ⇒ parse-error 并原样返回全文", () => {
    const broken = "# 标题\n<!-- 未闭合\n正文\n";
    const result = scanMarkdownView({
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

describe("纯文本与通用提示", () => {
  it("⑧ 纯文本原样返回；要求去注释时如实说明不支持", () => {
    const source = "第一行\n# 不是注释\n";
    const result = scanPlainTextView({
      sourceText: source,
      shouldIncludeComments: false,
      shouldIncludeImports: true,
    });
    expect(result.viewText).toBe(source);
    expect(result.filterStatus).toBe("not-filtered");
    expect(result.isViewComplete).toBe(true);
    expect(result.limitations.join("|")).toContain("comments-unsupported");
  });

  it("⑨ 导入提示只在需要时追加，且不改动其它字段", () => {
    const base = scanPlainTextView({
      sourceText: "abc\n",
      shouldIncludeComments: true,
      shouldIncludeImports: true,
    });
    expect(appendUnsupportedImportNotice(base, true)).toBe(base);

    const withNotice = appendUnsupportedImportNotice(base, false);
    expect(withNotice.limitations.join("|")).toContain("imports-unsupported");
    expect(withNotice.viewText).toBe(base.viewText);
    expect(withNotice.filterStatus).toBe(base.filterStatus);
  });
});
