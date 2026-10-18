#!/usr/bin/env node
/**
 * 契约层 SDK 的**包级验收**：隔离安装 tarball，用**已安装包**跑观测场景，
 * 再用可单测的判定（`scripts/lib/contract-sdk-checks.mjs`）判通过/失败。
 *
 * 用法：node scripts/verify-contract-sdk-package.mjs <tarball-path>
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildContractSdkChecks } from "./lib/contract-sdk-checks.mjs";

const tarballPath = process.argv[2];
if (tarballPath === undefined || !existsSync(tarballPath)) {
  console.error("用法: node scripts/verify-contract-sdk-package.mjs <tarball-path>");
  process.exit(1);
}

const scenarioPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "contract-sdk-scenario.mjs",
);
const workspace = mkdtempSync(path.join(os.tmpdir(), "astarray-contract-sdk-package-"));

try {
  const installResult = spawnSync(
    "npm",
    [
      "install",
      path.resolve(tarballPath),
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--prefer-offline",
    ],
    { cwd: workspace, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (installResult.status !== 0) {
    console.error("契约 SDK 包级验收：隔离安装失败");
    process.exit(1);
  }

  copyFileSync(scenarioPath, path.join(workspace, "scenario.mjs"));
  const scenarioResult = spawnSync(process.execPath, ["scenario.mjs"], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (scenarioResult.status !== 0) {
    process.stderr.write(scenarioResult.stderr ?? "");
    console.error("契约 SDK 包级验收：已安装包中的观测场景执行失败");
    process.exit(1);
  }

  const outputLines = (scenarioResult.stdout ?? "").trim().split("\n");
  const lastLine = outputLines[outputLines.length - 1];
  let observation;
  try {
    observation = JSON.parse(lastLine);
  } catch {
    console.error("契约 SDK 包级验收：无法解析观测输出");
    process.exit(1);
  }

  const result = buildContractSdkChecks(observation);
  for (const check of result.checks) {
    console.log(`${check.passed ? "✅" : "❌"} ${check.name} — ${check.detail}`);
  }
  console.log(`契约 SDK 包级验收：${result.summary}`);
  if (!result.isAccepted) {
    process.exitCode = 1;
  }
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
