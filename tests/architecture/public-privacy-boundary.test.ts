/**
 * 公开仓库隐私边界（2026-11-10）：**公开文档不得描述外部 UI 仓库的存在或结构**。
 *
 * 规则来源：`AGENTS.md` §0「公开仓库不得出现外部仓库的任何信息：仓库名、
 * 绝对/相对路径、目录结构、包名、测试路径、'存在外部仓库'的描述」。
 *
 * 现状：历史报告里已有 159 处此类措辞（57 个文件）。本轮**不清洗历史**——
 * 大规模改写历史报告会破坏记录，且是否需要改写历史属用户决策。
 * 本守卫的作用是**阻止新增**：新文件出现这些措辞即失败，
 * 已知文件记入 `KNOWN_LEGACY_FILES`，每删一项就少一处债务。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const DOCS_DIRECTORY_PATH = path.join(process.cwd(), "docs");

/** 会暴露外部 UI 仓库存在/结构的措辞（含仓库名与路径片段）。 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "外部 UI 包目录", pattern: /外部\s*GUI\s*包/u },
  { label: "外部 TUI 包目录", pattern: /外部\s*TUI\s*包/u },
  { label: "外部 UI 测试目录", pattern: /外部\s*GUI\s*测试/u },
  { label: "外部仓库名", pattern: /ui-package/u },
  /** 只匹配**真实用户名**：`C:\Users\<username>` 这类占位写法是刻意匿名，不算泄漏。 */
  { label: "本机用户目录", pattern: /C:\\Users\\<username>\.\.\.)/u },
];

/**
 * 历史文件白名单：已存在上述措辞的文档。
 *
 * **只减不增**：新增文件不得出现在这里；删除某文件里的措辞后应把它从名单移除。
 */
const KNOWN_LEGACY_FILES: ReadonlySet<string> = new Set([]);

async function listMarkdownFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(entryPath)));
      continue;
    }
    if (entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("公开文档隐私边界", () => {
  it("**新增**文档不得出现外部 UI 仓库的存在或结构描述", async () => {
    const markdownFiles = await listMarkdownFiles(DOCS_DIRECTORY_PATH);
    const offendingFiles: string[] = [];
    for (const filePath of markdownFiles) {
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/gu, "/");
      if (KNOWN_LEGACY_FILES.has(relativePath)) continue;
      const content = await fs.readFile(filePath, "utf8");
      if (FORBIDDEN_PATTERNS.some((entry) => entry.pattern.test(content))) {
        offendingFiles.push(relativePath);
      }
    }
    expect(offendingFiles).toEqual([]);
  }, 60_000);
});
