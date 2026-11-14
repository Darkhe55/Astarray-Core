/**
 * EXEC-01-06（2026-11-14）：**包级验收的本地可验证部分**。
 *
 * 卡内要求（§06）："npm pack 经正常 prepack，通过隔离安装包的公开入口运行同一闭环，
 * 记录 SHA256、HEAD、命令与退出码；施工环境缺失写 blocked，**不把 fake 后端通过当真实隔离验收**"。
 *
 * 本脚本只做"能在本机证明"的三件事：
 *  1. 公开入口确实导出沙箱自检（安装包装出来的产物里有这个能力）；
 *  2. **不支持的平台/缺失后端必须显式拒绝**（`isExecutionAllowed === false`），
 *     绝不允许"探测失败却放行"——这是 §02「不能以正常降级结案」的可执行形态；
 *  3. CLI 入口在本机可跑（mock 运行时、只读问答），退出码与 stdout 契约符合预期，
 *     且执行事件开关确实存在于打包产物中。
 *
 * **不做什么**：不声称真实隔离已验证。真实沙箱后端、干净设备、断网执行、多平台
 * 均属施工环境缺失，脚本会在结论里明确写 `blocked`。
 *
 * 用法：
 *   node scripts/verify-exec01-06-package.mjs --package-dir <node_modules/astarray> [--tarball <tgz>] [--output <json>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readArgumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const packageDirectoryArgument = readArgumentValue("--package-dir");
if (packageDirectoryArgument === undefined) {
  console.error("用法: node scripts/verify-exec01-06-package.mjs --package-dir <node_modules/astarray>");
  process.exit(2);
}

const packageDirectory = path.resolve(packageDirectoryArgument);
const tarballArgument = readArgumentValue("--tarball");
const outputArgument = readArgumentValue("--output");

const failures = [];
const checks = [];

function recordCheck(input) {
  checks.push(input);
  if (!input.isPassed) {
    failures.push(`${input.name}: ${input.detail}`);
  }
}

function computeTarballSha256(tarballPath) {
  const bytes = readFileSync(tarballPath);
  return createHash("sha256").update(bytes).digest("hex");
}

function readHeadCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** ① 公开入口导出沙箱自检。 */
const distributionDirectory = path.join(packageDirectory, "dist");
/**
 * 入口从**包的 package.json** 解析（`exports["."]` 优先），不猜文件名。
 *
 * 早期实现按 `dist/index.js` 猜，但该包实际入口是 `dist/public-sdk.js`，
 * 于是"入口存在"这条检查误报失败——猜文件名本身就是脆弱写法。
 */
function resolveDeclaredEntryPath() {
  const packageJsonPath = path.join(packageDirectory, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const exportedEntry = packageJson?.exports?.["."];
  const declaredPaths = [
    typeof exportedEntry === "string" ? exportedEntry : exportedEntry?.import,
    packageJson?.module,
    packageJson?.main,
  ].filter((declaredPath) => typeof declaredPath === "string");
  for (const declaredPath of declaredPaths) {
    const resolvedPath = path.resolve(packageDirectory, declaredPath);
    if (existsSync(resolvedPath)) {
      return resolvedPath;
    }
  }
  return undefined;
}

const entryPath =
  resolveDeclaredEntryPath() ??
  ["public-sdk.js", "index.js", "index.cjs", "index.mjs"]
    .map((fileName) => path.join(distributionDirectory, fileName))
    .find((candidate) => existsSync(candidate));
if (entryPath === undefined) {
  recordCheck({
    name: "打包产物入口存在",
    isPassed: false,
    detail: `未找到 dist/{index.js,index.cjs,index.mjs}：${packageDirectory}`,
  });
} else {
  recordCheck({
    name: "打包产物入口存在",
    isPassed: true,
    detail: path.relative(process.cwd(), entryPath),
  });
  const sdkModule = await import(pathToFileURL(entryPath).href);
  const selfCheck = sdkModule.buildSandboxSelfCheckReport;
  recordCheck({
    name: "公开入口导出 buildSandboxSelfCheckReport",
    isPassed: typeof selfCheck === "function",
    detail: typeof selfCheck === "function" ? "已导出" : "未导出（包内能力缺失）",
  });

  if (typeof selfCheck === "function") {
    /** ② 平台未交付 ⇒ 显式 unsupported，且不允许执行。 */
    const unsupportedReport = selfCheck({
      manifestVerification: {
        isVerified: false,
        failures: [
          {
            failureCode: "platform-not-supported",
            detail: "模拟：当前平台未交付基础执行能力",
            platform: process.platform,
            architecture: process.arch,
            componentIdentifier: null,
          },
        ],
      },
      capabilityProfile: {
        isAvailable: false,
        backendIdentifier: "none",
        isolationPrimitiveDescription: "未装配隔离后端",
        reasonUnavailable: "未装配沙箱执行后端：拒绝执行（不降级到宿主进程执行）",
      },
    });
    recordCheck({
      name: "平台不支持 ⇒ unsupported 且禁止执行",
      isPassed:
        unsupportedReport.status === "unsupported" &&
        unsupportedReport.isExecutionAllowed === false,
      detail: `status=${unsupportedReport.status} isExecutionAllowed=${unsupportedReport.isExecutionAllowed}`,
    });

    /** ③ 清单失败但后端"自称可用" ⇒ 仍不得放行（防静默降级）。 */
    const misleadingProfileReport = selfCheck({
      manifestVerification: {
        isVerified: false,
        failures: [
          {
            failureCode: "integrity-mismatch",
            detail: "模拟：组件哈希不符",
            platform: process.platform,
            architecture: process.arch,
            componentIdentifier: "sandbox-helper",
          },
        ],
      },
      capabilityProfile: {
        isAvailable: true,
        backendIdentifier: "fake-available",
        isolationPrimitiveDescription: "自称可用（不得据此放行）",
        reasonUnavailable: null,
      },
    });
    recordCheck({
      name: "清单失败 ⇒ 即使后端自称可用也不放行",
      isPassed:
        misleadingProfileReport.isExecutionAllowed === false &&
        misleadingProfileReport.status !== "ready",
      detail: `status=${misleadingProfileReport.status} isExecutionAllowed=${misleadingProfileReport.isExecutionAllowed}`,
    });
  }
}

/** ④ CLI 入口可跑（mock 运行时；只读问答，不触发真实 Provider）。 */
const cliPath = path.join(distributionDirectory, "cli.js");
if (!existsSync(cliPath)) {
  recordCheck({
    name: "打包产物 CLI 入口存在",
    isPassed: false,
    detail: `未找到 ${path.relative(process.cwd(), cliPath)}`,
  });
} else {
  let cliStandardOutput = "";
  let cliExitCode = 0;
  try {
    cliStandardOutput = execFileSync(
      process.execPath,
      [
        cliPath,
        "run",
        "只回复 OK",
        "--json",
        "--runtime",
        "mock",
        "--conversation",
        "--timeout-seconds",
        "30",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    cliExitCode = typeof error.status === "number" ? error.status : -1;
    cliStandardOutput = String(error.stdout ?? "");
  }
  let parsedResult = null;
  try {
    parsedResult = JSON.parse(cliStandardOutput.trim());
  } catch {
    parsedResult = null;
  }
  recordCheck({
    name: "隔离安装包的 CLI 入口跑通只读闭环",
    isPassed: cliExitCode === 0 && parsedResult !== null && typeof parsedResult.status === "string",
    detail: `exit=${cliExitCode} stdoutIsSingleJsonObject=${parsedResult !== null} status=${parsedResult?.status ?? "null"}`,
  });

  /** ⑤ 执行事件开关存在于打包产物（CLI 事件面被打进包）。 */
  const helpText = execFileSync(process.execPath, [cliPath, "run", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const hasEmitFlag = helpText.includes("--emit-execution-events");
  const hasNoEmitFlag = helpText.includes("--no-emit-execution-events");
  recordCheck({
    name: "打包产物含执行事件开关",
    isPassed: hasEmitFlag && hasNoEmitFlag,
    detail: `--emit-execution-events=${hasEmitFlag} --no-emit-execution-events=${hasNoEmitFlag}`,
  });
}

const evidence = {
  checkPoint: "EXEC-01-06",
  recordedAtIso: new Date().toISOString(),
  headCommit: readHeadCommit(),
  packageDirectory,
  ...(tarballArgument === undefined
    ? {}
    : { tarballSha256: computeTarballSha256(path.resolve(tarballArgument)) }),
  checks,
  /** 施工环境缺失的部分：不冒充通过。 */
  blockedByEnvironment: [
    "真实沙箱后端（AppContainer/bubblewrap 等真实适配）",
    "固定版本 Node 运行时与离线夹具",
    "干净设备安装自检与断网执行",
    "Windows/Linux/macOS 多平台证据",
  ],
  isPassed: failures.length === 0,
  failures,
};

if (outputArgument !== undefined) {
  writeFileSync(path.resolve(outputArgument), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

for (const check of checks) {
  console.log(`${check.isPassed ? "PASS" : "FAIL"}  ${check.name}  —  ${check.detail}`);
}
console.log(
  evidence.isPassed
    ? "结论：本地可验证部分通过（真实隔离与多平台仍为 blocked，未在此声明通过）"
    : `结论：失败 ${failures.length} 项`,
);
process.exit(evidence.isPassed ? 0 : 1);
