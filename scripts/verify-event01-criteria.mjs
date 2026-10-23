#!/usr/bin/env node
/**
 * EVENT-01 验收口径校验（2026-10-23）。
 *
 * 用法：
 *   npx tsx scripts/verify-event01-criteria.mjs --criteria <criteria.json> [--allow-incomplete]
 *
 * 退出码：
 * - 0：口径完整（`--allow-incomplete` 时，即使不完整也返回 0，仅供模板检查）；
 * - 2：口径不完整（默认：**不得开工**，缺失项会被逐条列出）；
 * - 1：文件不可读/JSON 非法。
 *
 * 纪律：本脚本**只校验口径**，不代表 EVENT-01 已实现或已通过。
 */
import { readFileSync } from "node:fs";

const criteriaModule = await import(
  "../packages/core/src/orchestration/event-acceptance-criteria.ts"
);

function parseArguments(argv) {
  const options = { criteriaPath: null, allowIncomplete: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--criteria") {
      options.criteriaPath = argv[index + 1] ?? null;
      index += 1;
    } else if (argv[index] === "--allow-incomplete") {
      options.allowIncomplete = true;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.criteriaPath === null) {
  process.stderr.write(
    "用法: npx tsx scripts/verify-event01-criteria.mjs --criteria <criteria.json> [--allow-incomplete]\n",
  );
  process.exit(2);
}

let criteria;
try {
  criteria = JSON.parse(readFileSync(options.criteriaPath, "utf8"));
} catch (error) {
  process.stderr.write(
    `无法读取/解析口径文件：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

const verdict = criteriaModule.evaluateEventAcceptanceCriteria(criteria);
process.stdout.write(`${JSON.stringify({ criteriaPath: options.criteriaPath, verdict }, null, 2)}\n`);

if (!verdict.isComplete) {
  process.stderr.write(`${verdict.reason}\n`);
  for (const problem of verdict.problems) {
    process.stderr.write(`- ${problem}\n`);
  }
  process.exit(options.allowIncomplete ? 0 : 2);
}

process.stderr.write("口径完整：可以开始实现 EVENT-01（实现完成后仍需按 requiredEvidence 逐条取证）。\n");
process.exit(0);
