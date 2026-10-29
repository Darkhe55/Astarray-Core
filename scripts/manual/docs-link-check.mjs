#!/usr/bin/env node
/**
 * R57 (2026-10-29): read-only dead-link check for documentation.
 *
 * Scans Markdown files under docs/ plus the repository root Markdown files, extracts relative
 * link targets of the form ](path) and checks that the target file exists. External URLs,
 * anchors and mailto links are ignored. It reads files only and never rewrites them.
 *
 * Exit code: 0 when every relative link resolves, 1 when at least one does not (so the report
 * can be regenerated and re-checked mechanically).
 *
 * Usage (from astarray/):
 *   node scripts/manual/docs-link-check.mjs
 *   node scripts/manual/docs-link-check.mjs > docs/reports/DOCS_LINK_CHECK.md
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const rootDirectory = process.cwd();
const ignoredDirectoryNames = new Set(["node_modules", "dist", ".git", ".tmp"]);

async function collectMarkdownFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (ignoredDirectoryNames.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
    } else if (entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

const files = [
  ...(await collectMarkdownFiles(path.join(rootDirectory, "docs"))),
  ...(await readdir(rootDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(rootDirectory, entry.name)),
].sort();

const deadLinks = [];
let checkedLinkCount = 0;

for (const filePath of files) {
  const rawContent = await readFile(filePath, "utf8");
  /**
   * 跳过**代码块与行内代码**：文档里常有 ](relative/path) 这类示例，
   * 它们不是真链接，按链接检查会产生假死链。
   */
  const content = rawContent
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");
  const relativeSource = path.relative(rootDirectory, filePath).replace(/\\/g, "/");
  for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const rawTarget = match[1];
    if (
      rawTarget.startsWith("http://") ||
      rawTarget.startsWith("https://") ||
      rawTarget.startsWith("mailto:") ||
      rawTarget.startsWith("#")
    ) {
      continue;
    }
    const target = rawTarget.split("#")[0];
    if (target === "") {
      continue;
    }
    checkedLinkCount += 1;
    const resolvedPath = path.resolve(path.dirname(filePath), target);
    let exists = false;
    try {
      const targetStat = await stat(resolvedPath);
      exists = targetStat.isFile() || targetStat.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      deadLinks.push({ source: relativeSource, target: rawTarget, resolved: resolvedPath });
    }
  }
}

process.stdout.write(
  "> 由只读脚本 `scripts/manual/docs-link-check.mjs` 生成；只检查**相对链接目标是否存在**，不校验内容。\n\n",
);
process.stdout.write(`- 扫描 Markdown 文件：**${files.length}** 个\n`);
process.stdout.write(`- 检查相对链接：**${checkedLinkCount}** 条\n`);
process.stdout.write(`- 死链：**${deadLinks.length}** 条\n\n`);

if (deadLinks.length === 0) {
  process.stdout.write("所有相对链接目标均存在。\n");
} else {
  process.stdout.write("| 来源文件 | 链接目标 |\n|---|---|\n");
  for (const deadLink of deadLinks) {
    process.stdout.write(`| ${deadLink.source} | \`${deadLink.target}\` |\n`);
  }
  process.stdout.write(
    "\n注意：本检查**只报告**，不修改任何文档；链接可能因文件移动/改名而失效。\n",
  );
}

process.exitCode = deadLinks.length === 0 ? 0 : 1;
