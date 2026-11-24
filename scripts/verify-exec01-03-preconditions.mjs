#!/usr/bin/env node
/**
 * RELEASE-01-03（B3）/ B6（Linux）：验收前置检查，**平台自适应**。
 *
 * 用法：
 *   node scripts/verify-exec01-03-preconditions.mjs            # 记录（exit 0）
 *   node scripts/verify-exec01-03-preconditions.mjs --strict   # 未就绪则 exit 2
 *
 * 纪律：
 * - 只读：不执行受控进程、不安装工具链、不提权；
 * - 缺什么就报什么（detail 给出可执行的下一步），不把"未知"写成"通过"；
 * - 输出不含用户名/主目录等本机标识（路径只给相对安装根）。
 *
 * 平台口径：
 * - Windows：sandbox-helper.exe（Rust/MSVC 构建）+ 一次 AppContainer 提权；
 * - Linux：bubblewrap（系统包）+ 非特权用户命名空间探测（不需要 .exe）；
 * - macOS/其它：平台未交付隔离后端（如实 blocked，不用别的平台冒名）。
 *
 * 测试支持（不影响产品路径）：`--probes <json>` 用给定探测结果替代真实探测，
 * 使平台分支可被确定性验证（CI 不依赖本机工具链）。
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MINIMUM_MAJOR = 20;

function readPackageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function commandVersion(command, argumentsList = ["--version"]) {
  const result = spawnSync(command, argumentsList, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const output = `${result.stdout ?? ""}`.trim().split(/\r?\n/u)[0] ?? "";
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

function probeBubblewrap() {
  const version = commandVersion("bwrap");
  if (version === null) {
    return { version: null, isUserNamespaceUsable: false };
  }
  const probe = spawnSync(
    "bwrap",
    ["--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--dev", "/dev", "--proc", "/proc", "true"],
    { encoding: "utf8", timeout: 30_000 },
  );
  return { version, isUserNamespaceUsable: probe.status === 0 };
}

function realProbes() {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    helperExists: existsSync(
      path.join(repositoryRoot, "native", "sandbox-helper", "sandbox-helper.exe"),
    ),
    rustcVersion: commandVersion("rustc"),
    cargoVersion: commandVersion("cargo"),
    elevated: isElevated(),
    ...probeBubblewrap(),
  };
}

function readProbesArgument() {
  const index = process.argv.indexOf("--probes");
  if (index === -1 || process.argv[index + 1] === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(process.argv[index + 1]);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    process.stderr.write("--probes 需要合法 JSON\n");
    process.exitCode = 2;
    return null;
  }
}

/** 纯构造：给定探测值 ⇒ 平台化清单（导出给测试不可用时也可被脚本内联使用）。 */
function buildPreconditionItems(probes) {
  const platform = probes.platform ?? process.platform;
  const architecture = probes.architecture ?? process.arch;
  const nodeMajor = Number.parseInt(String(probes.nodeVersion ?? process.version).replace(/^v/u, ""), 10);
  const nodeSupported = Number.isFinite(nodeMajor) && nodeMajor >= NODE_MINIMUM_MAJOR;

  const items = [];
  if (platform === "win32" || platform === "linux") {
    items.push({
      itemIdentifier: "platform-supported",
      status: "ok",
      detail: `平台 ${platform}/${architecture} 有受支持后端实现`,
    });
  } else {
    items.push({
      itemIdentifier: "platform-supported",
      status: "blocked",
      detail: `平台 ${platform} 未交付隔离后端（macOS 后端保留为后继能力，不是补测项）`,
    });
  }

  items.push({
    itemIdentifier: "node-version-supported",
    status: nodeSupported ? "ok" : "blocked",
    detail: nodeSupported
      ? `Node ${String(probes.nodeVersion ?? process.version).replace(/^v/u, "")}`
      : `Node ${String(probes.nodeVersion ?? process.version)} 低于 ${String(NODE_MINIMUM_MAJOR)}`,
  });

  if (platform === "win32") {
    items.push(
      {
        itemIdentifier: "sandbox-helper-built",
        status: probes.helperExists === true ? "ok" : "blocked",
        detail:
          probes.helperExists === true
            ? "已存在 native/sandbox-helper/sandbox-helper.exe"
            : "缺少 native/sandbox-helper/sandbox-helper.exe：需安装 Rust 工具链并运行 node scripts/build-sandbox-helper.mjs",
      },
      {
        itemIdentifier: "rust-toolchain",
        status:
          typeof probes.rustcVersion === "string" && typeof probes.cargoVersion === "string"
            ? "ok"
            : "blocked",
        detail:
          typeof probes.rustcVersion === "string" && typeof probes.cargoVersion === "string"
            ? `rustc: ${probes.rustcVersion}; cargo: ${probes.cargoVersion}`
            : "未找到 rustc/cargo：安装 Rust（含 MSVC 目标与 Windows SDK 链接器）需要用户授权",
      },
      {
        itemIdentifier: "elevated-for-appcontainer",
        status: probes.elevated === true ? "ok" : "blocked",
        detail:
          probes.elevated === true
            ? "当前进程具有管理员权限（可预建 AppContainer 档案）"
            : "非管理员：CreateAppContainerProfile 会返回 E_ACCESSDENIED；需在安装期预建档案或在提权会话中执行",
      },
    );
  } else if (platform === "linux") {
    const hasBubblewrap = typeof probes.bwrapVersion === "string";
    items.push(
      {
        itemIdentifier: "bubblewrap-installed",
        status: hasBubblewrap ? "ok" : "blocked",
        detail: hasBubblewrap
          ? `bwrap: ${probes.bwrapVersion}`
          : "未找到 bwrap：apt-get install -y bubblewrap（Linux 后端不需要 .exe）",
      },
      {
        itemIdentifier: "bubblewrap-user-namespace",
        status: probes.isUserNamespaceUsable === true ? "ok" : "blocked",
        detail:
          probes.isUserNamespaceUsable === true
            ? "bwrap --unshare-all 探测通过（非特权用户命名空间可用）"
            : "bwrap 探测失败：常见原因 = 未启用非特权用户命名空间，或 AppArmor 限制（Ubuntu 24.04 可设 kernel.apparmor_restrict_unprivileged_userns=0）",
      },
    );
  }

  return items;
}

const probesArgument = readProbesArgument();
const recordBase = probesArgument ?? realProbes();
const items = buildPreconditionItems(recordBase);
const blockers = items
  .filter((item) => item.status !== "ok")
  .map((item) => `${item.itemIdentifier}: ${item.detail}`);

const record = {
  status: "exec01-03-preconditions",
  recordedAtIso: new Date().toISOString(),
  platform: recordBase.platform ?? process.platform,
  architecture: recordBase.architecture ?? process.arch,
  osRelease: os.release(),
  nodeVersion: recordBase.nodeVersion ?? process.version,
  packageVersion: readPackageVersion(),
  applicationRootRelativePath: ".",
  items,
  readyForAcceptance: blockers.length === 0,
  blockers,
  note:
    "本检查只读：不执行受控进程、不安装工具链、不提权。readyForAcceptance=false 表示实测验收还不能开始，不代表产品缺陷。",
};

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

if (process.argv.includes("--strict") && blockers.length > 0) {
  process.stderr.write("exec01-03-preconditions: 未就绪，见 blockers\n");
  process.exitCode = 2;
}
