/**
 * EXEC-01-02：按平台装配**默认**沙箱执行后端。
 *
 * 纪律（用户裁决 2026-11-09）：
 *  - 找不到可用的隔离组件 ⇒ 返回 `null`，由控制器一律 `execution-backend-unsupported`；
 *  - **绝不**退回"在宿主上直接跑"；
 *  - **绝不**采用"网络不封"的弱隔离档（裁决明确不批准）。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import type { SandboxExecutionBackend } from "./process-execution-controller.js";
import { SandboxHelperBackend } from "./sandbox-helper-backend.js";

export interface PlatformSandboxBackendInput {
  /** 仓库/安装根（用于定位随包分发的辅助程序）。 */
  readonly applicationRootPath: string;
  /** 显式覆盖辅助程序路径（测试与高级部署用）。 */
  readonly helperExecutablePathOverride?: string;
}

/**
 * 解析辅助程序路径：显式覆盖 > 随包分发位置。
 *
 * 返回 `null` 表示**没有**该文件 —— 调用方不得据此假设"可以跑"。
 */
export function resolveSandboxHelperExecutablePath(
  input: PlatformSandboxBackendInput,
): string | null {
  if (input.helperExecutablePathOverride !== undefined) {
    return existsSync(input.helperExecutablePathOverride)
      ? input.helperExecutablePathOverride
      : null;
  }
  if (process.platform !== "win32") {
    /** 非 Windows 的辅助程序尚未交付（Linux 走 bwrap 包装，属另一实现）。 */
    return null;
  }
  const candidatePath = path.join(
    input.applicationRootPath,
    "native",
    "sandbox-helper",
    "sandbox-helper.exe",
  );
  return existsSync(candidatePath) ? candidatePath : null;
}

/**
 * 构造默认后端。
 *
 * `null` = 本机没有可用的隔离组件。这是**合法且常见**的结果：
 * 受控执行会因此一律拒绝，而不是在宿主上跑。
 */
export function createPlatformSandboxExecutionBackend(
  input: PlatformSandboxBackendInput,
): SandboxExecutionBackend | null {
  const helperExecutablePath = resolveSandboxHelperExecutablePath(input);
  if (helperExecutablePath === null) {
    return null;
  }
  return new SandboxHelperBackend({ helperExecutablePath });
}
