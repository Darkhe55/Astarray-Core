#!/usr/bin/env node
/**
 * DOCVIEW-01-03 公开入口计量验收（2026-10-20）。
 *
 * 用法：
 *   node scripts/verify-docview-measurement.mjs --package-dir <已安装包目录>
 *
 * 做什么：用**已安装的包**（不是源码）跑同一批文档，输出
 * 原文/提取后字节、token 估算（字符/4，明确标注为估算）、块数、降级块、已知损失、
 * 以及**逐类语义覆盖**（expected vs preserved）。判据：
 *   1. 三类文档（md/html/txt）都可抽取；
 *   2. **语义覆盖完整**（表格单元格/标题/脚注/公式/修订/隐藏内容一项不缺）；
 *   3. 计量字段齐全且 token 标注为估算（不冒充真 tokenizer）；
 *   4. 损坏文件如实报 corrupted（不半真半假）。
 *
 * 边界：不测真实 tokenizer、不渲染、不执行宏；峰值内存与耗时由本脚本用
 * `process.memoryUsage().heapUsed` 与 `performance.now()` 测量，标注为本进程口径。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { execFileSync } from "node:child_process";

function parseArguments(argv) {
  const options = { packageDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") {
      options.packageDirectory = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.packageDirectory === null) {
  process.stderr.write("用法: node scripts/verify-docview-measurement.mjs --package-dir <已安装包目录>\n");
  process.exit(2);
}

const packageRoot = path.resolve(options.packageDirectory);
const packageJsonPath = path.join(packageRoot, "package.json");
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const entryPath = path.join(packageRoot, "dist", "public-sdk.js");
try {
  await fs.access(entryPath);
} catch {
  process.stderr.write(`未找到公开入口：${entryPath}（需要先构建该包）\n`);
  process.exit(2);
}

const sdk = await import(new URL(`file://${entryPath.replaceAll("\\", "/")}`).href);
if (typeof sdk.extractDocumentBlocks !== "function" || typeof sdk.measureDocumentExtraction !== "function") {
  process.stderr.write("已安装包未导出 extractDocumentBlocks / measureDocumentExtraction\n");
  process.exit(1);
}

const samples = [
  {
    fileName: "sample.md",
    content: [
      "# 标题一",
      "## 标题二",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| a | 1 |",
      "| b | 2 |",
      "",
      "见脚注[^1]。",
      "[^1]: 脚注内容",
      "",
      "$$",
      "E=mc^2",
      "$$",
      "",
      "价格 ~~100~~ 改为 80。",
      "<!-- 内部备注：勿外发 -->",
    ].join("\n"),
  },
  {
    fileName: "sample.html",
    content: [
      "<h1>标题</h1>",
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>",
      "<p>正文 &amp; 转义</p>",
      "<del>旧值</del>",
      "<!-- 注释 -->",
    ].join("\n"),
  },
  { fileName: "sample.txt", content: "第一行\n第二行\n" },
];

const results = [];
for (const sample of samples) {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const extraction = sdk.extractDocumentBlocks(sample);
  const measurement = sdk.measureDocumentExtraction({
    fileName: sample.fileName,
    content: sample.content,
    extraction,
    measurementDurationMilliseconds: performance.now() - startedAt,
  });
  const heapAfter = process.memoryUsage().heapUsed;
  results.push({
    ...measurement,
    heapDeltaBytes: heapAfter - heapBefore,
    heapDeltaBasis: "process.heapUsed-delta",
    incompleteCategories: measurement.coverage
      .filter((entry) => !entry.isComplete)
      .map((entry) => `${entry.category}:${String(entry.preservedCount)}/${String(entry.expectedCount)}`),
  });
}

const corrupted = sdk.extractDocumentBlocks({ fileName: "broken.md", content: "# 标题\u0000正文" });

const failures = [];
for (const result of results) {
  if (result.kind !== "extracted") failures.push(`${result.fileName}: 期望 extracted，实际 ${result.kind}`);
  if (!result.isSemanticCoverageComplete) {
    failures.push(`${result.fileName}: 语义覆盖不完整 [${result.incompleteCategories.join(", ")}]`);
  }
  if (result.tokenEstimateBasis !== "characters/4-estimate") {
    failures.push(`${result.fileName}: token 必须标注为估算`);
  }
  if (result.measurementDurationMilliseconds === null) failures.push(`${result.fileName}: 缺少耗时`);
}
if (corrupted.kind !== "corrupted") failures.push(`损坏文件应报 corrupted，实际 ${corrupted.kind}`);

process.stdout.write(
  `${JSON.stringify(
    {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      measurement: results.map((result) => ({
        fileName: result.fileName,
        format: result.format,
        sourceBytes: result.sourceBytes,
        extractedBytes: result.extractedBytes,
        tokenEstimate: result.tokenEstimate,
        tokenEstimateBasis: result.tokenEstimateBasis,
        blockCount: result.blockCount,
        degradedBlockCount: result.degradedBlockCount,
        knownLossCount: result.knownLossCount,
        isSemanticCoverageComplete: result.isSemanticCoverageComplete,
        coverage: result.coverage,
        measurementDurationMilliseconds: Number(result.measurementDurationMilliseconds.toFixed(3)),
        heapDeltaBytes: result.heapDeltaBytes,
      })),
      corruptedFileReportedAs: corrupted.kind,
      failures,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  process.stderr.write(`DOCVIEW 计量验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("DOCVIEW 计量验收通过：语义覆盖完整、token 标注为估算、损坏文件如实拒绝\n");
