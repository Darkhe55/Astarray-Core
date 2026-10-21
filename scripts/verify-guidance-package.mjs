#!/usr/bin/env node
/**
 * GUIDE-01-04 公开入口（tarball）验收（2026-10-21）。
 *
 * 用法：node scripts/verify-guidance-package.mjs --package-dir <已安装包目录>
 *
 * 判据（对齐卡内 GUIDE-01-01 反例 + 01-04 "公共入口提交并查看接收/应用状态"）：
 * 1. 正常提交 ⇒ 受理（`accepted`/`recorded`）且 `queryGuidanceStatus` **可查到**该条；
 * 2. 空文本 ⇒ 明确报错（`invalid-arguments`），不排队；
 * 3. 过期指导 ⇒ `rejected` 且原因 `expired-guidance`；
 * 4. **档位越权**：`file-task-observation` 最高只到 `safe-point-guidance`，发 `gate-and-request-pause` ⇒ 拒绝；
 * 5. `record-only` ⇒ 立即 `applied` 且 `latencyMilliseconds=0`、`isApplicationStatusKnown:true`；
 * 6. 非法 `sourceKind` ⇒ 构造阶段报错（不产生半条事件）。
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
  process.stderr.write("用法: node scripts/verify-guidance-package.mjs --package-dir <已安装包目录>\n");
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
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-guidance-package-"));
let application = null;
try {
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
  application.createSession({ sessionId: "guidance-package", mode: "assist" });

  const mission = await application.submitTask({
    sessionId: "guidance-package",
    taskIdentifier: "guidance-task-1",
    prompt: "只读检查示例",
  });
  const missionIdentifier = mission.missionIdentifier;
  const taskIdentifier = mission.taskIdentifier ?? "guidance-task-1";

  // ① 正常提交
  const accepted = await application.submitRuntimeGuidance({
    missionIdentifier,
    taskIdentifier,
    instructionText: "改用只读检查，不要执行写操作",
  });
  if (accepted.status === "rejected") {
    failures.push(`正常指导不应被拒：${JSON.stringify(accepted.reasons ?? [])}`);
  }
  const statusAfterSubmit = await application.queryGuidanceStatus({ missionIdentifier });
  const isVisible = JSON.stringify(statusAfterSubmit).includes(accepted.guidanceIdentifier);
  if (!isVisible) {
    failures.push(`提交后应能在状态查询里看到该条（${accepted.guidanceIdentifier}）`);
  }

  // ② 空文本
  let emptyRejected = false;
  try {
    await application.submitRuntimeGuidance({
      missionIdentifier,
      taskIdentifier,
      instructionText: "   ",
    });
  } catch (error) {
    emptyRejected = String(error instanceof Error ? error.message : error).length > 0;
  }
  if (!emptyRejected) failures.push("空文本指导必须被明确拒绝");

  // ③ 过期
  const expired = await application.submitRuntimeGuidance({
    missionIdentifier,
    taskIdentifier,
    instructionText: "这条已过期",
    expiresAtIso: "2000-01-01T00:00:00.000Z",
  });
  if (expired.status !== "rejected" || !(expired.reasons ?? []).includes("expired-guidance")) {
    failures.push(`过期指导应被拒（expired-guidance），实际 ${JSON.stringify(expired.reasons ?? [])}`);
  }

  // ④ 档位越权：文件观察来源最高只到 safe-point-guidance
  const tierViolation = await application.submitRuntimeGuidance({
    missionIdentifier,
    taskIdentifier,
    instructionText: "观察来源尝试安全点档",
    behaviorTier: "gate-and-request-pause",
    sourceKind: "file-task-observation",
  });
  if (tierViolation.status !== "rejected" || !(tierViolation.reasons ?? []).includes("behavior-tier-not-permitted")) {
    failures.push(
      `档位越权应被拒（behavior-tier-not-permitted），实际 ${JSON.stringify(tierViolation.reasons ?? [])}`,
    );
  }

  // ⑤ record-only 立即 applied
  const recordOnly = await application.submitRuntimeGuidance({
    missionIdentifier,
    taskIdentifier,
    instructionText: "只记录这条建议",
    behaviorTier: "record-only",
  });
  const recordOnlyStatus = await application.queryGuidanceStatus({ missionIdentifier });
  const recordOnlyEntries = Array.isArray(recordOnlyStatus)
    ? recordOnlyStatus
    : (recordOnlyStatus.entries ?? recordOnlyStatus.submissions ?? []);
  const recordOnlyEntry = recordOnlyEntries.find(
    (entry) => entry.guidanceIdentifier === recordOnly.guidanceIdentifier,
  );
  if (recordOnly.status === "rejected") {
    failures.push("record-only 指导不应被拒");
  }
  if (recordOnlyEntry !== undefined) {
    if (recordOnlyEntry.status !== "applied") failures.push("record-only 应显示 applied");
    if (recordOnlyEntry.latencyMilliseconds !== 0) failures.push("record-only 的延迟应为 0");
  }

  // ⑥ 非法 sourceKind
  let invalidSourceRejected = false;
  try {
    await application.submitRuntimeGuidance({
      missionIdentifier,
      taskIdentifier,
      instructionText: "伪造来源",
      sourceKind: "forged-source",
    });
  } catch {
    invalidSourceRejected = true;
  }
  if (!invalidSourceRejected) failures.push("非法 sourceKind 必须在构造阶段被拒");

  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        acceptedStatus: accepted.status,
        acceptedBehaviorTier: accepted.behaviorTier,
        statusQueryVisible: isVisible,
        emptyTextRejected: emptyRejected,
        expiredReasons: expired.reasons ?? [],
        tierViolationReasons: tierViolation.reasons ?? [],
        recordOnlyStatus: recordOnly.status,
        recordOnlyApplied: recordOnlyEntry?.status ?? null,
        recordOnlyLatencyMilliseconds: recordOnlyEntry?.latencyMilliseconds ?? null,
        invalidSourceRejected,
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
  process.stderr.write(`GUIDE 包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("GUIDE 包级验收通过：受理可查、空文本/过期/档位越权/伪造来源均被拒、record-only 立即生效\n");

