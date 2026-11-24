#!/usr/bin/env node
/**
 * RELEASE-01-03（B3）/ B6（Linux）：验收前置检查，**平台自适应**。
 *
 * 用法：
 *   node scripts/verify-exec01-03-preconditions.mjs            # 记录（exit 0）
 *   node scripts/verify-exec01-03-preconditions.mjs --strict   # 未就绪则 exit 2
 *   node scripts/verify-exec01-03-preconditions.mjs --with-probe --strict
 *     # 额外执行一次 helper probe（创建并删除一个 AppContainer 档案 + Job），
 *     # 用实测证据替代"是否管理员"的代理判断
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
  /**
   * 与真实后端（bubblewrap-sandbox-backend）的探测形态保持一致：
   * 整根只读 bind + 绝对路径 /bin/true。
   *
   * 教训（2026-11-24，用户实测）：只 bind /usr,/dev,/proc 再让 PATH 解析 `true`，
   * 在部分 Ubuntu 镜像上会失败（execvp true: No such file or directory）。
   * 探测必须"跑真实会用到的形态"，而不是一个更宽松的假形态。
   */
  const probe = spawnSync(
    "bwrap",
    [
      "--unshare-all",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "/bin/true",
    ],
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

/**
 * 运行 helper 的 `probe`（显式 --with-probe 才执行）。
 *
 * 副作用：创建并删除一个 AppContainer 档案、创建一个 Job Object（均即时回收）。
 * 这是当前 Windows 构建上**唯一能证明"AppContainer 真的可用"的证据**；
 * 2026-11-25 实测：非管理员会话也能创建档案（旧假设"必须提权"不成立）。
 */
function probeAppContainer(helperPath) {
  const result = spawnSync(helperPath, ["probe"], { encoding: "utf8", timeout: 30_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const hasProfile =
    output.includes("appcontainer-created sid-present=true") ||
    output.includes("appcontainer-existing sid-present=true");
  const passed =
    result.status === 0 && hasProfile && output.includes("job-created") && !output.includes("appcontainer-unavailable");
  return { passed, output, exitCode: result.status };
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
        itemIdentifier: "appcontainer-availability",
        /**
         * 优先用 **helper probe 实测**（appcontainer-created + job-created）；
         * 没跑 probe 时退回"提权代理判断"（保守），并明确说明这只是代理。
         */
        status:
          probes.appContainerProbePassed === true || probes.elevated === true
            ? "ok"
            : "blocked",
        detail:
          probes.appContainerProbePassed === true
            ? "helper probe 实测通过：AppContainer 档案可创建/删除（sid-present=true）+ Job 可创建（本机非管理员亦可）"
            : probes.elevated === true
              ? "当前进程具有管理员权限（可预建 AppContainer 档案；未跑实测 probe）"
              : "未跑实测 probe 且非管理员：旧假设认为 CreateAppContainerProfile 会返回 E_ACCESSDENIED；可加 --with-probe 获取实测证据",
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
const recordBase = { ...(probesArgument ?? realProbes()) };
if (
  process.argv.includes("--with-probe") &&
  (probesArgument === null || probesArgument.appContainerProbePassed === undefined)
) {
  const helperPath = path.join(
    repositoryRoot,
    "native",
    "sandbox-helper",
    "sandbox-helper.exe",
  );
  if (existsSync(helperPath) && (recordBase.platform ?? process.platform) === "win32") {
    const probe = probeAppContainer(helperPath);
    recordBase.appContainerProbePassed = probe.passed;
    if (!probe.passed) {
      recordBase.appContainerProbeOutput = probe.output;
    }
  }
}
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
  note: process.argv.includes("--with-probe")
    ? "本检查不安装工具链、不提权；--with-probe 会执行一次 helper probe（创建并删除一个 AppContainer 档案 + 一个 Job，均即时回收）。readyForAcceptance=false 表示实测验收还不能开始，不代表产品缺陷。"
    : "本检查只读：不执行受控进程、不安装工具链、不提权。readyForAcceptance=false 表示实测验收还不能开始，不代表产品缺陷。",
};

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);

if (process.argv.includes("--strict") && blockers.length > 0) {
  process.stderr.write("exec01-03-preconditions: 未就绪，见 blockers\n");
  process.exitCode = 2;
}
