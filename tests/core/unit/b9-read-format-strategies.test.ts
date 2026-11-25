/**
 * B9（2026-11-25）：读取格式策略注册表（按扩展名/样例解析策略、生成读取回执）。
 *
 * 纪律：未支持格式**返回原文并显式标注 unsupported**，不得静默丢弃或假装过滤成功。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_READ_FORMAT_STRATEGIES,
  ReadFormatStrategyRegistry,
  defaultReadFormatStrategyRegistry,
} from "../../../packages/core/src/tools/read-format/read-format-strategies.js";

describe("B9：读取格式策略注册表", () => {
  it("① 默认策略集非空且注册表可列出副本", () => {
    expect(DEFAULT_READ_FORMAT_STRATEGIES.length).toBeGreaterThan(0);
    const registry = new ReadFormatStrategyRegistry();
    const listed = registry.listStrategies();
    expect(listed.length).toBe(DEFAULT_READ_FORMAT_STRATEGIES.length);
    expect(defaultReadFormatStrategyRegistry.listStrategies().length).toBeGreaterThan(0);
  });

  it("② 按扩展名解析：md/go/sh/sql/txt 各自命中；未知扩展 ⇒ null", () => {
    const registry = new ReadFormatStrategyRegistry();
    const cases: Array<[string, string]> = [
      ["README.md", "markdown"],
      ["main.go", "go"],
      ["run.sh", "shell"],
      ["query.sql", "sql"],
      ["notes.txt", "plain-text"],
    ];
    for (const [fileName, expectedIdPart] of cases) {
      const strategy = registry.resolve({ fileName });
      expect(strategy, fileName).not.toBeNull();
      expect(strategy?.strategyId).toContain(expectedIdPart);
    }
    expect(registry.resolve({ fileName: "binary.xyz" })).toBeNull();
  });

  it("③ 显式 extension 覆盖文件名扩展名", () => {
    const registry = new ReadFormatStrategyRegistry();
    const strategy = registry.resolve({ fileName: "noext", extension: ".md" });
    expect(strategy?.strategyId).toContain("markdown");
  });

  it("④ 未支持格式：返回原文 + strategyId=unsupported + 明确 limitation", () => {
    const registry = new ReadFormatStrategyRegistry();
    const receipt = registry.buildReadView({
      filePath: "binary.xyz",
      sourceText: "原始内容",
    });
    expect(receipt.strategyId).toBe("unsupported");
    expect(receipt.viewText).toBe("原始内容");
    expect(receipt.filterStatus).toBe("unsupported");
    expect(receipt.isFilterable).toBe(false);
    expect(receipt.limitations.join("")).toContain("format-unsupported");
  });

  it("⑤ 支持的格式：回执带策略标识、能力与行映射，且测量单位为 utf-8 字节", () => {
    const registry = new ReadFormatStrategyRegistry();
    const sourceText = "# 标题\n\n正文内容\n";
    const receipt = registry.buildReadView({
      filePath: "doc.md",
      sourceText,
      shouldIncludeComments: false,
      shouldIncludeImports: false,
      isSensitiveCheckApplied: true,
    });
    expect(receipt.strategyId).not.toBe("unsupported");
    expect(receipt.viewParameters).toMatchObject({
      shouldIncludeComments: false,
      shouldIncludeImports: false,
    });
    expect(receipt.sensitiveCheckAppliedBeforeView).toBe(true);
    expect(Array.isArray(receipt.lineMap)).toBe(true);
    expect(receipt.measuredUnits).toBe(Buffer.byteLength(receipt.viewText, "utf8"));
    expect(typeof receipt.isViewComplete).toBe("boolean");
  });

  it("⑥ 解析优先级：更高 specificity 的匹配胜出（不按注册顺序）", () => {
    const registry = new ReadFormatStrategyRegistry();
    /** 文件名为 .md 但内容样例是 shell shebang：仍按扩展名判定，不误判。 */
    const strategy = registry.resolve({
      fileName: "doc.md",
      contentSample: "#!/bin/sh\necho hi\n",
    });
    expect(strategy?.strategyId).toContain("markdown");
  });
});
