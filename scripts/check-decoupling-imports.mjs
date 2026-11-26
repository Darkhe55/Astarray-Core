#!/usr/bin/env node
/**
 * AXIOMATIC-DESIGN P5（2026-11-26）：解耦 import 规则检查入口。
 *
 * 用法：
 *   node scripts/check-decoupling-imports.mjs            # 违规 ⇒ 退出码 1
 *   node scripts/check-decoupling-imports.mjs --json     # 同时输出解耦指标 JSON
 */
import path from "node:path";

import {
  collectDecouplingMetrics,
  collectTsFiles,
  findFacadeBypassViolations,
  findImportViolations,
} from "./lib/decoupling-import-rules.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const files = [];
for (const directory of ["packages/core/src/public-sdk-facets", "packages/core/src/orchestration"]) {
  files.push(...(await collectTsFiles(repositoryRoot, directory)));
}

const violations = findImportViolations(files);
const cliFiles = await collectTsFiles(repositoryRoot, "packages/tui/src");
const bypassViolations = findFacadeBypassViolations(cliFiles);
const isJsonRequested = process.argv.includes("--json");
const metrics = isJsonRequested ? await collectDecouplingMetrics(repositoryRoot) : null;

if (violations.length > 0 || bypassViolations.length > 0) {
  console.error(
    `decoupling-imports: ${String(violations.length + bypassViolations.length)} 处违规`,
  );
  for (const violation of violations) {
    console.error(`  [${violation.rule}] ${violation.path} → ${violation.specifier}`);
  }
  for (const violation of bypassViolations) {
    console.error(
      `  [${violation.rule}] ${violation.path}:${String(violation.line)} → ${violation.methodName}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("decoupling-imports-ok: facet/服务单向依赖与 CLI 窄依赖规则均未发现违规");
}

if (metrics !== null) {
  console.log(JSON.stringify(metrics, null, 2));
}
