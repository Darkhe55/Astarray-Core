#!/usr/bin/env node
/**
 * CLI `--json` 包级验收（2026-10-23）。
 *
 * 用法：node scripts/verify-cli-json-package.mjs --package-dir <已安装包目录>
 *
 * 判据：安装包里的 `dist/cli.js` 在**空状态**下对四个只读命令返回 0，且 JSON 结构稳定：
 * - `usage overview --json`：`coverage/metrics/usageSource/costEstimate/budget/page`，金额恒未估算；
 * - `obs diag --json`：`kind:"ok"`、`isReportable:false`、`coverage.discardedLineCount`；
 * - `obs perf --json`：`kind:"ok"`、`metrics.sampleSize:0`、`hasSamples:false`；
 * - `accuracy status --json`：`status:"ok"`、`policy.tier/budget/revision`。
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  process.stderr.write("用法: node scripts/verify-cli-json-package.mjs --package-dir <已安装包目录>\n");
  process.exit(2);
}

const packageRoot = path.resolve(options.packageDirectory);
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const cliPath = path.join(packageRoot, "dist", "cli.js");
try {
  await fs.access(cliPath);
} catch {
  process.stderr.write(`未找到 CLI 入口：${cliPath}\n`);
  process.exit(2);
}

const failures = [];
const observations = {};
const workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-json-e2e-"));

function runJson(argumentsList) {
  const result = spawnSync(process.execPath, [cliPath, ...argumentsList, "--json"], {
    encoding: "utf8",
    cwd: workingDirectory,
    env: { ...process.env },
  });
  let payload = null;
  try {
    payload = result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
  } catch {
    payload = null;
  }
  return { status: result.status, payload, stderr: result.stderr };
}

try {
  // ① usage overview
  const usage = runJson(["usage", "overview"]);
  observations.usageStatus = usage.status;
  const usageKeys = usage.payload === null ? [] : Object.keys(usage.payload);
  observations.usageKeys = usageKeys;
  if (usage.status !== 0 || usage.payload === null) failures.push("usage overview --json 应成功返回 JSON");
  for (const key of ["coverage", "metrics", "usageSource", "costEstimate", "budget", "page"]) {
    if (!usageKeys.includes(key)) failures.push(`usage overview 缺少字段 ${key}`);
  }
  const costEstimate = usage.payload?.costEstimate;
  observations.usageCostEstimate = costEstimate ?? null;
  if (costEstimate !== undefined && costEstimate !== null && costEstimate.amountMinorUnits !== null) {
    failures.push("usage overview 不得给出金额（应恒为未估算）");
  }

  // ② obs diag
  const diag = runJson(["obs", "diag"]);
  observations.diagStatus = diag.status;
  if (diag.status !== 0 || diag.payload?.kind !== "ok") failures.push("obs diag --json 应返回 kind=ok");
  if (diag.payload?.isReportable !== false) failures.push("空库 obs diag 应 isReportable=false");
  if (typeof diag.payload?.coverage?.discardedLineCount !== "number") {
    failures.push("obs diag 缺少 coverage.discardedLineCount");
  }

  // ③ obs perf
  const perf = runJson(["obs", "perf"]);
  observations.perfStatus = perf.status;
  if (perf.status !== 0 || perf.payload?.kind !== "ok") failures.push("obs perf --json 应返回 kind=ok");
  if (perf.payload?.metrics?.sampleSize !== 0) failures.push("空库 obs perf 的 metrics.sampleSize 应为 0");
  if (perf.payload?.hasSamples !== false) failures.push("空库 obs perf 应 hasSamples=false");

  // ④ accuracy status
  const accuracy = runJson(["accuracy", "status"]);
  observations.accuracyStatus = accuracy.status;
  if (accuracy.status !== 0 || accuracy.payload?.status !== "ok") {
    failures.push("accuracy status --json 应返回 status=ok");
  }
  for (const key of ["tier", "isEnabled", "budget", "revision"]) {
    if (!(key in (accuracy.payload?.policy ?? {}))) failures.push(`accuracy policy 缺少字段 ${key}`);
  }

  process.stdout.write(
    `${JSON.stringify(
      { packageName: packageJson.name, packageVersion: packageJson.version, observations, failures },
      null,
      2,
    )}\n`,
  );
} finally {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`CLI JSON 包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write(
  "CLI JSON 包级验收通过：usage/obs diag/obs perf/accuracy status 的输出结构与退出码稳定，金额恒未估算\n",
);
