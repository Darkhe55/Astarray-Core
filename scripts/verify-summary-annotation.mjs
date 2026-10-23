#!/usr/bin/env node
/**
 * SUM-02-04 人工标注评估（2026-10-23）。
 *
 * 用法：
 *   npx tsx scripts/verify-summary-annotation.mjs --samples <samples.jsonl> [--minimum 30]
 *
 * 判据：
 * 1. 每行一个 JSON 样本，字段见模板 `docs/reports/SUM02_04_ANNOTATION_TEMPLATE.jsonl`；
 * 2. **出现 `annotatorKind != "human"` ⇒ 退出码 1**（卡内：不能用生成模型自评通过）；
 * 3. 可用样本不足 ⇒ 输出 `insufficient-sample`（退出码仍 0，但**不是通过**，报告里必须写样本规模）；
 * 4. 指标一律带**分母**；无可用样本时 precision/recall 为 null。
 *
 * 退出码：2 = 用法/解析错误；1 = 非人工标注；0 = 已评估或样本不足（见输出 conclusion）。
 */
import { readFileSync } from "node:fs";

const evaluationModule = await import(
  "../packages/core/src/summarization/summary-annotation-evaluation.ts"
);

function parseArguments(argv) {
  const options = { samplesPath: null, minimumRequiredSampleCount: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--samples") {
      options.samplesPath = argv[index + 1] ?? null;
      index += 1;
    } else if (argv[index] === "--minimum") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      options.minimumRequiredSampleCount = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.samplesPath === null) {
  process.stderr.write(
    "用法: npx tsx scripts/verify-summary-annotation.mjs --samples <samples.jsonl> [--minimum 30]\n",
  );
  process.exit(2);
}

let rawText;
try {
  rawText = readFileSync(options.samplesPath, "utf8");
} catch (error) {
  process.stderr.write(`无法读取样本文件：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const samples = [];
const parseErrors = [];
rawText
  .split("\n")
  .forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    try {
      samples.push(JSON.parse(trimmed));
    } catch (error) {
      parseErrors.push({ lineNumber: lineIndex + 1, message: error instanceof Error ? error.message : String(error) });
    }
  });

if (parseErrors.length > 0) {
  process.stderr.write(`${JSON.stringify({ parseErrors }, null, 2)}\n`);
  process.exit(2);
}

const evaluation = evaluationModule.evaluateSummaryAnnotations({
  samples,
  ...(options.minimumRequiredSampleCount === undefined
    ? {}
    : { minimumRequiredSampleCount: options.minimumRequiredSampleCount }),
});

process.stdout.write(`${JSON.stringify({ samplesPath: options.samplesPath, evaluation }, null, 2)}\n`);

if (evaluation.isModelSelfAnnotated) {
  process.stderr.write("存在非人工标注：整份评估不成立（退出码 1）。\n");
  process.exit(1);
}
if (evaluation.conclusion === "insufficient-sample") {
  process.stderr.write(
    `可用人工标注 ${String(evaluation.usableSampleCount)} 条（低于 ${String(
      evaluation.minimumRequiredSampleCount,
    )}）：输出结论不是“通过”，请补样本。\n`,
  );
}
process.exit(0);
