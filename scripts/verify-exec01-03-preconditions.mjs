#!/usr/bin/env node
/**
 * RELEASE-01-03（B3）验收前置检查：把"平台/工具链/提权/后端"逐项记录成可复现清单。
 *
 * 用法：
 *   node scripts/verify-exec01-03-preconditions.mjs           # 记录（exit 0）
 *   node scripts/verify-exec01-03-preconditions.mjs --strict  # 未就绪则 exit 2
 *
 * 纪律：
 * - 只读：不执行受控进程、不安装工具链、不提权；
 * - 缺什么就报什么（reason 给出可执行的下一步），不把"未知"写成"通过"；
 * - 输出不含用户名/主目录等本机标识（路径只给相对安装根）。
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function commandVersion(command) {
  const isWindows = process.platform === "win32";
  const result = isWindows
    ? spawnSync(command + " --version", { encoding: "utf8", windowsHide: true, shell: true })
    : spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const output = `${result.stdout ?? ""}`.trim().split("\n")[0] ?? "";
  return output === "" ? null : output;
}

/** Windows：`net session` 需要管理员权限；非 Windows 用 effective uid 判定。 */
function isElevated() {
  if (process.platform !== "win32") {
    return typeof process.getuid === "function" && process.getuid() === 0;
  }
  const result = spawnSync("net session", { windowsHide: true, shell: true });
  return result.status === 0;
}

const helperRelativePath = path.join("native", "sandbox-helper", "sandbox-helper.exe");
const helperPath = path.join(repositoryRoot, helperRelativePath);
const helperExists = existsSync(helperPath);
const rustcVersion = commandVersion("rustc");
const cargoVersion = commandVersion("cargo");
const elevated = isElevated();

const items = [
  {
    itemIdentifier: "platform-supported",
    status: process.platform === "win32" || process.platform === "linux" ? "ok" : "blocked",
    detail:
      process.platform === "win32" || process.platform === "linux"
        ? `平台 ${process.platform}/${process.arch} 有受支持后端实现`
        : `平台 ${process.platform} 未交付隔离后端`,
  },
  {
    itemIdentifier: "sandbox-helper-built",
    status: helperExists ? "ok" : "blocked",
    detail: helperExists
      ? `已存在 ${helperRelativePath}`
      : `缺少 ${helperRelativePath}：需安装 Rust 工具链并运行 rustc -O src/main.rs -o sandbox-helper.exe`,
  },
  {
    itemIdentifier: "rust-toolchain",
    status: rustcVersion === null || cargoVersion === null ? "blocked" : "ok",
    detail:
      rustcVersion === null || cargoVersion === null
        ? "未找到 rustc/cargo：安装 Rust（含 MSVC 目标与 Windows SDK 链接器）需要用户授权"
        : `rustc: ${rustcVersion}; cargo: ${cargoVersion}`,
  },
  {
    itemIdentifier: "elevated-for-appcontainer",
    status: elevated ? "ok" : "blocked",
    detail: elevated
      ? "当前进程具有管理员权限（可预建 AppContainer 档案）"
      : "非管理员：CreateAppContainerProfile 会返回 E_ACCESSDENIED；需在安装期预建档案或在提权会话中执行",
  },
];

const blockers = items
  .filter((item) => item.status !== "ok")
  .map((item) => `${item.itemIdentifier}: ${item.detail}`);

const record = {
  status: "exec01-03-preconditions",
  recordedAtIso: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  osRelease: os.release(),
  nodeVersion: process.version,
  packageVersion: readPackageVersion(),
  applicationRootRelativePath: ".",
  items,
  readyForAcceptance: blockers.length === 0,
  blockers,
  note:
    "本检查只读：不执行受控进程、不安装工具链、不提权。readyForAcceptance=false 表示 B3 实测验收还不能开始，不代表产品缺陷。",
};

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

if (process.argv.includes("--strict") && blockers.length > 0) {
  process.stderr.write("exec01-03-preconditions: 未就绪，见 blockers\n");
  process.exitCode = 2;
}
