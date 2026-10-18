#!/usr/bin/env node
/**
 * RELOCATE 批量对账验证（**脱敏样例**，2026-10-19 R33）。
 *
 * 用户 2026-10-19 批准：真实历史库暂不提供，**用脱敏样例**验证"批量解析 + 恢复门禁"。
 *
 * 做法：用**已构建的公开 SDK**（`dist/public-sdk.js`）对脱敏样例逐项目跑
 * `reconcileProjectRelocation`，把结果压成计数/稳定代码，再交给可单测的判定器
 * （`scripts/lib/relocation-batch-sample.mjs`）。全程不写盘、不联网、不调模型。
 *
 * 用法：node scripts/verify-relocation-batch-sample.mjs [--json]
 * 前置：npm run build（脚本会检查 dist 是否存在）
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRelocationBatchChecks,
  buildSanitizedRelocationSample,
  summarizeReconciliation,
} from "./lib/relocation-batch-sample.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicSdkPath = path.join(repositoryRoot, "dist", "public-sdk.js");
if (!existsSync(publicSdkPath)) {
  console.error("缺少 dist/public-sdk.js：请先运行 npm run build");
  process.exit(1);
}
const { reconcileProjectRelocation } = await import(`file://${publicSdkPath.replaceAll("\\", "/")}`);

const sample = buildSanitizedRelocationSample();
const observations = [];
for (const project of sample.projects) {
  const reconciliation = reconcileProjectRelocation({
    projectIdentifier: project.projectIdentifier,
    projectStatus: project.projectStatus,
    locationMappings: project.locationMappings,
    declaredStructuredResourceKinds: project.declaredStructuredResourceKinds,
    references: project.references,
    pendingOperations: project.pendingOperations,
    hasWriteOrExternalSideEffects: project.hasWriteOrExternalSideEffects,
  });
  observations.push(summarizeReconciliation(project.projectIdentifier, reconciliation));
}

const observation = { isSanitized: sample.isSanitized, projects: observations };
const result = buildRelocationBatchChecks(observation);
for (const check of result.checks) {
  console.log(`${check.passed ? "✅" : "❌"} ${check.name} — ${check.detail}`);
}
console.log(`RELOCATE 批量对账（脱敏样例）：${result.summary}`);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(observation));
}
if (!result.isAccepted) process.exitCode = 1;
