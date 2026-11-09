/**
 * CLI 引导（T11）：解析界面层交互端口与反馈入口路径，委托公共应用运行时装配。
 * 装配实现见 packages/core/src/application/application-runtime.ts（T07D-R1-01 提取）。
 */
import path from "node:path";

import { resolveHostUserIdentifier } from "../../../core/src/core/host-user-context.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createApplicationRuntime,
  type ApplicationRuntime,
  type ApplicationRuntimeOptions,
} from "../../../core/src/application/application-runtime.js";
import { InteractiveBackupDeletionAuthorizationPort } from "./backup-deletion-port.js";
import { InteractiveInstallationGatePort } from "./install-decision-port.js";

export type CliBootstrap = ApplicationRuntime;
export type BootstrapOptions = ApplicationRuntimeOptions;

export async function bootstrapCli(options: BootstrapOptions): Promise<CliBootstrap> {
  return createApplicationRuntime({
    ...options,
    backupDeletionControlPort: new InteractiveBackupDeletionAuthorizationPort({
      warnOutput: process.stderr,
    }),
    installationUserPort: new InteractiveInstallationGatePort({
      isInteractive: () => process.stdin.isTTY === true,
    }),
    // 检查点 B：身份来自可信宿主用户上下文；主 Agent 实例 ID 逐运行时唯一（不再固定）
    authenticatedUserId: resolveHostUserIdentifier(),
    feedbackProcessModulePath: resolveFeedbackEntryPath(),
    /**
     * EXEC-01-02（2026-11-09）：产品入口**显式开启**沙箱后端自动探测。
     *
     * 构造后端本身不启动进程；只有真的尝试受控执行时才探测一次（60 秒缓存）。
     * 探测不可用 ⇒ 执行被拒绝，**不回落**到宿主进程执行。
     */
    isSandboxBackendAutoDetected: true,
    sandboxApplicationRootPath: resolveApplicationRootPath(),
  });
}

/**
 * 解析应用根（用于定位随包分发的原生沙箱组件）。
 *
 * 从编译产物位置向上找：`dist/cli/` → `dist/` → 包根。
 */
function resolveApplicationRootPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  /**
   * **向上查找**而不是按固定层数推断：源码运行时在 `packages/tui/src/cli`，
   * 构建产物在 `dist/cli`，两者到包根的层数不同（实测按固定层数在源码下指错目录，
   * 导致后端永远解析为 null —— 表面上"未装配"，看起来像没接线）。
   */
  let candidateDirectory = moduleDirectory;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(candidateDirectory, "native", "sandbox-helper"))) {
      return candidateDirectory;
    }
    const parentDirectory = path.dirname(candidateDirectory);
    if (parentDirectory === candidateDirectory) break;
    candidateDirectory = parentDirectory;
  }
  return path.resolve(moduleDirectory, "..", "..");
}

function resolveFeedbackEntryPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, "feedback-process-entry.js"),
    path.join(
      moduleDirectory,
      "..",
      "..",
      "..",
      "..",
      "dist",
      "feedback-process-entry.js",
    ),
    path.join(process.cwd(), "dist", "feedback-process-entry.js"),
  ];
  return (
    candidates.find((candidatePath) => existsSync(candidatePath)) ?? candidates[0]!
  );
}
