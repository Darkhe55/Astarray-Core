#!/usr/bin/env node
/**
 * ACCURACY-03 公开入口（tarball）验收（2026-10-21）。
 *
 * 用法：node scripts/verify-accuracy-settings-package.mjs --package-dir <已安装包目录>
 *
 * 判据（卡内："设置与产品入口、增量 E2E；**关闭后无新增模型审查或人工阻塞**；状态诚实；
 * 标准/严格**工作量有上限**；不影响权限路由"）：
 * 1. 默认策略：`tier=standard`、`isEnabled=true`、预算默认值（模型调用 4 次 / 墙钟 120s）；
 * 2. **Agent 不得降级/关闭**（`requestingAgentInstanceId` 非空 + tier 降级或 disable ⇒ 拒绝）；
 * 3. **revision 冲突** ⇒ 拒绝（不覆盖并发改动）；
 * 4. 非法预算（负数/非整数）⇒ `accuracy-policy-invalid`；
 * 5. **关闭后状态诚实**：`isEnabled:false` 可读回，且不影响权限组（权限组 reference 不变）；
 * 6. 可开启并读回（设置真的生效，不是只回显）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArguments(argv) {
  const options = { packageDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") {
      options.packageDirectory = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.packageDirectory === null) {
  process.stderr.write("用法: node scripts/verify-accuracy-settings-package.mjs --package-dir <已安装包目录>\n");
  process.exit(2);
}

const packageRoot = path.resolve(options.packageDirectory);
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const entryPath = path.join(packageRoot, "dist", "public-sdk.js");
try {
  await fs.access(entryPath);
} catch {
  process.stderr.write(`未找到公开入口：${entryPath}（需要先构建该包）\n`);
  process.exit(2);
}

const sdk = await import(new URL(`file://${entryPath.replaceAll("\\", "/")}`).href);
if (typeof sdk.AstarrayApplicationFacade !== "function") {
  process.stderr.write("已安装包未导出 AstarrayApplicationFacade\n");
  process.exit(1);
}

const failures = [];
const observations = {};
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-accuracy-settings-"));
let application = null;

async function createApplication() {
  application = await sdk.AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
  });
  application.createSession({ sessionId: "accuracy-settings", mode: "assist" });
  return application;
}

try {
  const app = await createApplication();

  // ① 默认策略
  const defaults = await app.queryAccuracyPolicy();
  observations.defaults = {
    tier: defaults.tier,
    isEnabled: defaults.isEnabled,
    budget: defaults.budget,
    revision: defaults.revision,
  };
  if (defaults.tier !== "standard") failures.push(`默认档位应为 standard，实际 ${String(defaults.tier)}`);
  if (defaults.isEnabled !== true) failures.push("默认应启用准确性检查");
  if (defaults.budget?.maximumModelCallCount !== 4) {
    failures.push(`默认模型调用上限应为 4，实际 ${String(defaults.budget?.maximumModelCallCount)}`);
  }
  if (defaults.budget?.maximumWallClockMilliseconds !== 120_000) {
    failures.push(`默认墙钟上限应为 120000，实际 ${String(defaults.budget?.maximumWallClockMilliseconds)}`);
  }

  // ② Agent 不得降级/关闭
  let agentDowngradeRejected = null;
  try {
    await app.configureAccuracyPolicy({
      tier: "fast",
      expectedRevision: defaults.revision,
      requestingAgentInstanceId: "worker-agent-1",
    });
  } catch (error) {
    agentDowngradeRejected = String(error?.code ?? "") + " | " + String(error?.message ?? error);
  }
  observations.agentDowngradeRejected = agentDowngradeRejected;
  if (
    agentDowngradeRejected === null ||
    !(agentDowngradeRejected.includes("downgrade") || agentDowngradeRejected.includes("不得自行降级"))
  ) {
    failures.push(`Agent 降级应被拒（accuracy-tier-downgrade-rejected），实际 ${String(agentDowngradeRejected)}`);
  }
  let agentDisableRejected = null;
  try {
    await app.configureAccuracyPolicy({
      isEnabled: false,
      expectedRevision: defaults.revision,
      requestingAgentInstanceId: "worker-agent-1",
    });
  } catch (error) {
    agentDisableRejected = String(error?.code ?? "") + " | " + String(error?.message ?? error);
  }
  observations.agentDisableRejected = agentDisableRejected;
  if (
    agentDisableRejected === null ||
    !(agentDisableRejected.includes("downgrade") || agentDisableRejected.includes("不得自行降级"))
  ) {
    failures.push("Agent 关闭准确性检查应被拒");
  }

  // ③ revision 冲突
  let staleRevisionRejected = null;
  try {
    await app.configureAccuracyPolicy({ tier: "strict", expectedRevision: defaults.revision + 10 });
  } catch (error) {
    staleRevisionRejected = String(error?.code ?? "") + " | " + String(error?.message ?? error);
  }
  observations.staleRevisionRejected = staleRevisionRejected;
  if (
    staleRevisionRejected === null ||
    !(staleRevisionRejected.includes("stale") || staleRevisionRejected.includes("revision 不匹配"))
  ) {
    failures.push("revision 冲突应被拒（accuracy-policy-stale-revision）");
  }

  // ④ 非法预算
  let invalidBudgetRejected = null;
  try {
    await app.configureAccuracyPolicy({ maximumModelCallCount: -1, expectedRevision: defaults.revision });
  } catch (error) {
    invalidBudgetRejected = String(error?.code ?? "") + " | " + String(error?.message ?? error);
  }
  observations.invalidBudgetRejected = invalidBudgetRejected;
  if (invalidBudgetRejected === null) failures.push("负数预算应被拒（accuracy-policy-invalid）");

  // ⑤ 用户可设置 strict + 预算上限，并读回（真生效）
  const permissionProfileBefore = await app.getCurrentPermissionProfileReference();
  const strictPolicy = await app.configureAccuracyPolicy({
    tier: "strict",
    maximumModelCallCount: 2,
    maximumWallClockMilliseconds: 60_000,
    expectedRevision: defaults.revision,
  });
  observations.strictPolicy = {
    tier: strictPolicy.tier,
    isEnabled: strictPolicy.isEnabled,
    budget: strictPolicy.budget,
    revision: strictPolicy.revision,
  };
  if (strictPolicy.tier !== "strict") failures.push("用户设置 strict 后应读回 strict");
  if (strictPolicy.budget?.maximumModelCallCount !== 2) failures.push("预算应读回 2");

  // ⑥ 用户可关闭；关闭后读回 isEnabled=false，且权限组不受影响
  const disabledPolicy = await app.configureAccuracyPolicy({
    isEnabled: false,
    expectedRevision: strictPolicy.revision,
  });
  observations.disabledPolicy = { isEnabled: disabledPolicy.isEnabled, tier: disabledPolicy.tier };
  if (disabledPolicy.isEnabled !== false) failures.push("关闭后应读回 isEnabled=false");
  const permissionProfileAfter = await app.getCurrentPermissionProfileReference();
  if (JSON.stringify(permissionProfileBefore) !== JSON.stringify(permissionProfileAfter)) {
    failures.push("准确性设置不应影响权限组（权限路由无关）");
  }

  // 7 关闭状态在**新实例**（重启）后仍然保持（设置落盘）
  await app.shutdown();
  application = null;
  const reloaded = await createApplication();
  const reloadedPolicy = await reloaded.queryAccuracyPolicy();
  observations.reloadedPolicy = { isEnabled: reloadedPolicy.isEnabled, tier: reloadedPolicy.tier };
  if (reloadedPolicy.isEnabled !== false) failures.push("重启后关闭状态应保持（设置需落盘）");

  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        observations,
        failures,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (application !== null) await application.shutdown().catch(() => {});
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`ACCURACY 设置包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("ACCURACY 设置包级验收通过：默认值、Agent 不可降级、revision 冲突、预算校验、关闭可读回且落盘、不影响权限组\n");


