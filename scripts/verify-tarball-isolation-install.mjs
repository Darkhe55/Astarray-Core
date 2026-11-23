#!/usr/bin/env node
/**
 * 包级 tarball 隔离安装验证（2026-11-18）。
 *
 * 交付纪律要求打包验收以 **tarball 隔离安装** 为准。本脚本：
 * 1. `npm pack --ignore-scripts`（跳过 prepack 的重复门禁，门禁已由 check 覆盖）；
 * 2. 在空目录里 `npm init -y` + 安装该 tarball；
 * 3. 用安装后的 `dist/cli.js` 跑 `--version`，确认可执行；
 * 4. 清理临时目录与 tarball。
 *
 * 用法：node scripts/verify-tarball-isolation-install.mjs
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function quoteArgument(argument) {
  return /\s/u.test(argument) ? `"${argument}"` : argument;
}

function runCommand(command, argumentsList, options) {
  /**
   * Windows 下 npm 是 .cmd，只能经 shell 执行；其余命令（node 等）
   * 直接 spawn，避免路径含空格时的二次转义问题。
   */
  const requiresShell = command === "npm";
  const result = requiresShell
    ? spawnSync(
        `${quoteArgument(command)} ${argumentsList.map(quoteArgument).join(" ")}`,
        {
          encoding: "utf8",
          windowsHide: true,
          shell: true,
          ...options,
        },
      )
    : spawnSync(command, argumentsList, {
        encoding: "utf8",
        windowsHide: true,
        ...options,
      });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${argumentsList.join(" ")} 失败（退出码 ${String(
        result.status,
      )}）：\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2000)}`,
    );
  }
  return `${result.stdout ?? ""}`;
}

async function main() {
  const packOutput = runCommand("npm", ["pack", "--ignore-scripts", "--json"], {
    cwd: repositoryRoot,
  });
  const packed = JSON.parse(packOutput.trim());
  const tarballFileName = Array.isArray(packed) ? packed[0].filename : packed.filename;
  const tarballPath = path.join(repositoryRoot, tarballFileName);
  const installDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-tarball-"));
  try {
    runCommand("npm", ["init", "-y"], { cwd: installDirectory });
    runCommand("npm", ["install", tarballPath, "--no-audit", "--no-fund"], {
      cwd: installDirectory,
    });

    const cliPath = path.join(installDirectory, "node_modules", "astarray", "dist", "cli.js");
    await fs.access(cliPath);
    const versionText = runCommand(process.execPath, [cliPath, "--version"], {
      cwd: installDirectory,
    }).trim();
    if (!/^\d+\.\d+\.\d+/u.test(versionText)) {
      throw new Error(`安装后的 CLI 未输出版本号：${versionText.slice(0, 200)}`);
    }
    console.log(`tarball-isolation-install-ok: 安装后 CLI 版本 ${versionText}`);

    /**
     * RELEASE-01-03（2026-11-24）：在**隔离安装产物**上产出受控执行验收记录。
     *
     * 只读诊断：不启动进程、不写状态。记录必须自洽——没有后端就不能声称可执行；
     * 缺 helper 是"待验证/阻塞"，不是安装失败（安装本身已成功）。
     */
    const applicationRootPath = path.dirname(path.dirname(cliPath));
    const recordText = runCommand(process.execPath, [
      cliPath,
      "sandbox",
      "self-check",
      "--json",
      "--application-root",
      applicationRootPath,
    ], { cwd: installDirectory });
    const record = JSON.parse(recordText);
    for (const key of [
      "schemaVersion",
      "platform",
      "architecture",
      "nodeVersion",
      "backendKind",
      "helperExecutablePath",
      "components",
      "isExecutionAllowed",
      "nextActionText",
    ]) {
      if (!(key in record)) {
        throw new Error(`验收记录缺少字段 ${key}`);
      }
    }
    if (record.backendKind === null && record.isExecutionAllowed !== false) {
      throw new Error("验收记录自相矛盾：无隔离后端却标记为可执行");
    }
    console.log(
      `sandbox-acceptance-record: platform=${record.platform}/${record.architecture} ` +
        `backendKind=${String(record.backendKind)} isExecutionAllowed=${String(record.isExecutionAllowed)}`,
    );
  } finally {
    await fs.rm(installDirectory, { recursive: true, force: true, maxRetries: 10 });
    await fs.rm(tarballPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
