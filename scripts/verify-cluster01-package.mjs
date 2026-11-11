#!/usr/bin/env node
/**
 * AUDIT-REPAIR-01 检查点 05-3 / CLUSTER-01 包级验收：
 * 在**隔离安装**的包里，只通过公开入口跑一条闭环，不 import 仓库源码路径。
 *
 * 用法：node scripts/verify-cluster01-package.mjs --package-dir .tmp/audit05-install
 *
 * 判定：退出码 0 表示通过；任一步失败即非 0 并打印原因。
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const packageDirectory = readArgument("--package-dir");
if (packageDirectory === null) {
  console.error("缺少 --package-dir <隔离安装目录>");
  process.exit(2);
}

/** 从**隔离安装目录的 node_modules** 解析包入口，禁止回落到仓库源码。 */
const entryPath = path.join(packageDirectory, "node_modules", "astarray", "dist", "public-sdk.js");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (entryPath.startsWith(repositoryRoot + path.sep)) {
  console.error("疑似从仓库源码导入：", entryPath);
  process.exit(2);
}

const module = await import(pathToFileURL(entryPath).href);
if (typeof module.AstarrayApplicationFacade !== "function") {
  console.error("包入口没有导出 AstarrayApplicationFacade");
  process.exit(2);
}

const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-package-"));
let failureCount = 0;
try {
  const facade = await module.AstarrayApplicationFacade.create({
    mode: "assist",
    stateDirectory,
    authenticatedUserId: "user-1",
    isDiagnosticClusteringEnabled: true,
  });

  /** ① 未构建前必须是 no-snapshot（不能是空结果）。 */
  const beforeBuild = await facade.getDiagnosticClusteringStatus("project-alpha");
  if (beforeBuild.status !== "no-snapshot") {
    console.error("① 未构建状态错误：", beforeBuild.status);
    failureCount += 1;
  }

  /** ② 构建快照。 */
  const built = await facade.buildDiagnosticClusterSnapshot({
    projectIdentifier: "project-alpha",
    generatedAtIso: "2026-11-11T00:00:00.000Z",
    resolveProjectIdentifier: () => "project-alpha",
  });
  if (built.status !== "built" || built.snapshot.isComplete !== true) {
    console.error("② 构建未成功或非完整：", built.status);
    failureCount += 1;
  }

  /** ③ 关闭开关的新实例必须返回 disabled（默认关，不因包内状态而开启）。 */
  const disabledFacade = await module.AstarrayApplicationFacade.create({
    mode: "assist",
    stateDirectory,
    authenticatedUserId: "user-1",
  });
  const disabledStatus = await disabledFacade.getDiagnosticClusteringStatus("project-alpha");
  if (disabledStatus.status !== "disabled") {
    console.error("③ 缺省应关闭，实际：", disabledStatus.status);
    failureCount += 1;
  }

  console.log("cluster01-package-closed-loop: " + (failureCount === 0 ? "ok" : "failed"));
  console.log("  entry=" + entryPath);
  console.log("  cases=3 failures=" + String(failureCount));
} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}

process.exit(failureCount === 0 ? 0 : 1);
