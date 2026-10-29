#!/usr/bin/env node
/**
 * R40 (2026-10-29): read-only status index for task cards.
 *
 * Scans docs/tasks/*.md (top level and accepted/) and reports, per file:
 * - how many distinct checkpoint identifiers appear (R\d+ / 第 N 轮);
 * - which ADR identifiers are referenced;
 * - whether the file mentions being blocked or incomplete;
 * - the most recent date that appears in the file.
 *
 * It reads documentation only. It does not import product code, does not touch state and
 * cannot verify any product behaviour: counts are documentation facts, nothing more.
 *
 * Usage (from astarray/):
 *   node scripts/manual/taskcard-status-index.mjs
 *   node scripts/manual/taskcard-status-index.mjs > docs/reports/TASKCARD_STATUS_VIEW.md
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const tasksDirectory = path.join(process.cwd(), "docs", "tasks");

async function collectMarkdownFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
    } else if (entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

function countDistinctCheckpoints(content) {
  const identifiers = new Set();
  for (const match of content.matchAll(/\bR(\d{1,2})\b/g)) {
    identifiers.add(`R${match[1]}`);
  }
  for (const match of content.matchAll(/第\s*(\d{1,3})\s*轮/g)) {
    identifiers.add(`round-${match[1]}`);
  }
  return identifiers.size;
}

function collectAdrIdentifiers(content) {
  const identifiers = new Set();
  for (const match of content.matchAll(/ADR-(\d{4})/g)) {
    identifiers.add(`ADR-${match[1]}`);
  }
  return [...identifiers].sort();
}

function findLatestDate(content) {
  const dates = [...content.matchAll(/(20\d{2}-\d{2}-\d{2})/g)].map((match) => match[1]);
  if (dates.length === 0) {
    return null;
  }
  return dates.sort().at(-1);
}

const files = (await collectMarkdownFiles(tasksDirectory)).sort();
const rows = [];
for (const filePath of files) {
  const content = await readFile(filePath, "utf8");
  const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
  rows.push({
    relativePath,
    checkpointCount: countDistinctCheckpoints(content),
    adrIdentifiers: collectAdrIdentifiers(content),
    mentionsBlocked: /平台阻塞|blocked/i.test(content),
    mentionsIncomplete: /未完成|in_progress/.test(content),
    latestDate: findLatestDate(content),
    lineCount: content.split(/\r?\n/).length,
  });
}

process.stdout.write(
  "> 由只读脚本 `scripts/manual/taskcard-status-index.mjs` 生成；只统计**文档事实**，不验证任何产品行为。\n\n",
);
process.stdout.write("| 任务卡 | checkpoint 标识数 | ADR 引用数 | 提到阻塞 | 提到未完成 | 最近日期 | 行数 |\n");
process.stdout.write("|---|---|---|---|---|---|---|\n");
for (const row of rows) {
  process.stdout.write(
    `| ${row.relativePath} | ${row.checkpointCount} | ${row.adrIdentifiers.length} | ` +
      `${row.mentionsBlocked ? "是" : "否"} | ${row.mentionsIncomplete ? "是" : "否"} | ` +
      `${row.latestDate ?? "-"} | ${row.lineCount} |\n`,
  );
}
process.stdout.write(
  `\n合计 ${rows.length} 个文件；其中提到"未完成/in_progress"的有 ` +
    `${rows.filter((row) => row.mentionsIncomplete).length} 个，提到"平台阻塞"的有 ` +
    `${rows.filter((row) => row.mentionsBlocked).length} 个。\n`,
);
