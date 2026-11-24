/**
 * B3 前置：构建 Windows 沙箱辅助程序（**只构建，不安装任何工具链**）。
 *
 * 纪律：
 * - 不自动下载/安装 Rust/MSVC；缺工具链时打印**确切的安装命令**并以 2 退出；
 * - 构建成功后在**当前（非提权）会话**运行一次 `probe`：AppContainer 预期返回 E_ACCESSDENIED，
 *   这不是失败，而是"还差一次提权初始化"的证据；
 * - 退出码：0 = 已构建且 probe 全绿（需已提权/档案已预建）；3 = 已构建，但 AppContainer 需提权；
 *   2 = 工具链缺失；1 = 构建或 probe 意外失败。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const helperDirectory = path.join(process.cwd(), "native", "sandbox-helper");
const sourcePath = path.join(helperDirectory, "src", "main.rs");
const outputPath = path.join(helperDirectory, "sandbox-helper.exe");

const installInstructions = [
  "缺少 Rust/MSVC 工具链。需要你（用户）显式授权安装，二选一：",
  "",
  "A. 自动安装（PowerShell，需网络与管理员/UAC 同意）：",
  "   winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements",
  "   winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements `",
  '     --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
  "   rustup default stable-msvc",
  "",
  "B. 手动安装：",
  "   https://rustup.rs/  （安装时选择 MSVC 目标）",
  "   https://visualstudio.microsoft.com/visual-cpp-build-tools/ （勾选“使用 C++ 的桌面开发”）",
  "",
  "安装完成后重新运行：node scripts/build-sandbox-helper.mjs",
].join("\n");

function findOnPath(command) {
  const result = spawnSync("where.exe", [command], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const first = result.stdout.split(/\r?\n/u).find((line) => line.trim() !== "");
  return first === undefined ? null : first.trim();
}

function main() {
  if (process.platform !== "win32") {
    console.error("本脚本只处理 Windows（B3 的 Windows 后端）；Linux 后端用 bubblewrap（B6）。");
    return 2;
  }
  if (!existsSync(sourcePath)) {
    console.error(`找不到源码：${sourcePath}`);
    return 1;
  }
  const rustc = findOnPath("rustc");
  if (rustc === null) {
    console.error(installInstructions);
    console.error("\n（本机检查：未找到 rustc/cargo/link/cl。）");
    return 2;
  }

  console.log(`rustc: ${rustc}`);
  console.log("构建中：rustc -O src/main.rs -o sandbox-helper.exe");
  const build = spawnSync(rustc, ["-O", "src/main.rs", "-o", "sandbox-helper.exe"], {
    cwd: helperDirectory,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (build.status !== 0 || !existsSync(outputPath)) {
    console.error("构建失败：");
    console.error(build.stderr || build.stdout || "（无输出）");
    if (/link\.exe|LNK|MSVC|linker/iu.test(`${build.stderr ?? ""}`)) {
      console.error("\n看起来是缺少 MSVC 链接器：安装 Visual Studio Build Tools（VCTools 工作负载）后重试。");
    }
    return 1;
  }
  console.log(`构建成功：${outputPath}`);

  const probe = spawnSync(outputPath, ["probe"], { encoding: "utf8", timeout: 60_000 });
  const probeText = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  console.log(`probe 退出码 ${String(probe.status)}`);
  if (probeText !== "") console.log(probeText);

  if (probe.status === 0) {
    console.log("\nprobe 全绿：B3 的前置已满足，可运行验收：");
    console.log("  node scripts/verify-exec01-03-preconditions.mjs --strict");
    return 0;
  }
  if (/appcontainer-unavailable|access is denied|E_ACCESSDENIED|0x80070005/iu.test(probeText)) {
    console.log("\nAppContainer 需要一次提权初始化（预期行为，不是代码缺陷）。下一步：");
    console.log("  1) 以管理员身份打开 PowerShell（一次性）；");
    console.log(`  2) 运行：& "${outputPath}" probe（应返回全绿）；`);
    console.log("  3) 回到普通会话运行：node scripts/verify-exec01-03-preconditions.mjs --strict");
    console.log("  4) 把输出发给我，我据此启动 EXEC-01 验收。");
    return 3;
  }
  console.error("probe 失败原因不在已知分类内，请把上面的输出发给我。");
  return 1;
}

process.exitCode = main();
