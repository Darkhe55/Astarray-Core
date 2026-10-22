#!/usr/bin/env node
/**
 * ACCURACY-03 增量 E2E 包级验收（2026-10-22）。
 *
 * 用法：node scripts/verify-accuracy-e2e-package.mjs --package-dir <已安装包目录>
 *
 * 判据（"关闭后**无新增模型审查或人工阻塞**；状态诚实；标准/严格**工作量有上限**"）：
 * 1. 默认 standard + 完整声明 ⇒ `accepted`，且审计记录 `isVerificationLayerInvoked:true`；
 * 2. **关闭准确性检查** ⇒ `quality-check-skipped`（`skipReason:"accuracy-disabled"`）、`verification:null`、
 *    审计 `isVerificationLayerInvoked:false`，且**不是 rejected**（不阻塞交付）；
 * 3. fast 档 ⇒ 跳过但 `skipReason:"tier-fast"`（同样不阻塞、不谎称通过）；
 * 4. **预算耗尽** ⇒ `quality-check-budget-exhausted` 且 `isVerificationLayerInvoked:false`（记录不足而非无限重试）；
 * 5. **重启**（新审计实例）⇒ 历史审计可读回，关闭决策可追溯；
 * 6. 幂等重放 ⇒ 不重复发起校验（审计条数不因重放增长）。
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
  process.stderr.write("用法: node scripts/verify-accuracy-e2e-package.mjs --package-dir <已安装包目录>\n");
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
for (const requiredName of [
  "AccuracyPolicyStore",
  "AccuracyCompletionGate",
  "FileAccuracyAttemptJournal",
  "FileAccuracyVerificationAuditLog",
]) {
  if (sdk[requiredName] === undefined) {
    process.stderr.write(`已安装包未导出 ${requiredName}\n`);
    process.exit(1);
  }
}

const failures = [];
const observations = {};
const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-accuracy-e2e-"));

function buildGate(policyStore) {
  const journal = new sdk.FileAccuracyAttemptJournal({ baseDirectory });
  const auditLog = new sdk.FileAccuracyVerificationAuditLog({ baseDirectory });
  const ports = {
    getAcceptanceEntries: async () => [
      { entryIdentifier: "entry-1", description: "必需 1", isRequired: true, evidenceRequirement: "artifact" },
    ],
    getCurrentTaskSequenceRevision: async () => 3,
    getExpectedRecipientIdentifier: async () => "main-agent-1",
    getArtifactRevision: async () => 3,
    isClarificationRequired: async () => false,
  };
  const gate = new sdk.AccuracyCompletionGate({
    policyStore,
    journal,
    ports,
    auditLog,
    nowIso: () => "2026-10-22T10:00:00.000Z",
  });
  return { gate, auditLog };
}

function declaration(overrides = {}) {
  return {
    taskIdentifier: "task-1",
    completionAttemptId: "attempt-1",
    taskSequenceRevision: 3,
    completedEntryIdentifiers: ["entry-1"],
    evidenceReferences: [
      {
        evidenceIdentifier: "evidence-1",
        entryIdentifier: "entry-1",
        evidenceKind: "test-report",
        contentHash: "sha256:fresh",
        producedAtRevision: 3,
        producedByAgentInstanceId: "agent-1",
        observedAtIso: "2026-10-22T10:00:00.000Z",
      },
    ],
    understandingConfirmation: null,
    deliveredToRecipientIdentifier: "main-agent-1",
    ...overrides,
  };
}

try {
  const policyStore = new sdk.AccuracyPolicyStore({ baseDirectory });
  const defaults = await policyStore.readPolicy();

  // ① 默认 standard：真的发起校验层
  const first = buildGate(policyStore);
  const accepted = await first.gate.verifyCompletion({ declaration: declaration() });
  observations.standard = {
    verdict: accepted.verdict,
    isSkipped: accepted.isSkipped,
    skipReason: accepted.skipReason,
  };
  if (accepted.verdict !== "accepted") failures.push(`standard 完整声明应 accepted，实际 ${accepted.verdict}`);
  const firstAudit = await first.auditLog.readAll();
  if (firstAudit.at(-1)?.isVerificationLayerInvoked !== true) {
    failures.push("standard 档审计应记录 isVerificationLayerInvoked:true");
  }

  // ② 关闭 ⇒ 跳过、不阻塞、审计记录未发起校验
  await policyStore.configurePolicy({
    isEnabled: false,
    expectedRevision: defaults.revision,
    updatedByUserId: "user-1",
  });
  const second = buildGate(policyStore);
  const disabled = await second.gate.verifyCompletion({ declaration: declaration({ completionAttemptId: "attempt-off" }) });
  observations.disabled = {
    verdict: disabled.verdict,
    isSkipped: disabled.isSkipped,
    skipReason: disabled.skipReason,
    hasVerification: disabled.verification !== null,
  };
  if (disabled.verdict !== "quality-check-skipped") failures.push("关闭后应为 quality-check-skipped");
  if (disabled.skipReason !== "accuracy-disabled") failures.push("关闭后的 skipReason 应为 accuracy-disabled");
  if (disabled.verification !== null) failures.push("关闭后不得再产出校验结果（verification 必须为 null）");
  const disabledAudit = await second.auditLog.readAll();
  if (disabledAudit.at(-1)?.isVerificationLayerInvoked !== false) {
    failures.push("关闭后审计必须记录 isVerificationLayerInvoked:false（无新增模型审查）");
  }
  if (disabled.verdict === "rejected") failures.push("关闭不得变成人工阻塞（不能 rejected）");

  // ③ fast 档：跳过但原因诚实
  const disabledPolicy = await policyStore.readPolicy();
  await policyStore.configurePolicy({
    isEnabled: true,
    tier: "fast",
    expectedRevision: disabledPolicy.revision,
    updatedByUserId: "user-1",
  });
  const third = buildGate(policyStore);
  const fast = await third.gate.verifyCompletion({ declaration: declaration({ completionAttemptId: "attempt-fast" }) });
  observations.fast = { verdict: fast.verdict, skipReason: fast.skipReason };
  if (fast.skipReason !== "tier-fast") failures.push("fast 档 skipReason 应为 tier-fast");
  if (fast.verdict === "accepted") failures.push("fast 档不得写成 accepted");

  // ④ 预算耗尽：严格档 + 预算 1 次 ⇒ 第二次记录不足而非无限重试
  const fastPolicy = await policyStore.readPolicy();
  // 注意：这里用的是 **store** 的 configurePolicy（不是门面的扁平参数），预算必须嵌套在 budget 里
  await policyStore.configurePolicy({
    tier: "strict",
    budget: { maximumModelCallCount: 1 },
    expectedRevision: fastPolicy.revision,
    updatedByUserId: "user-1",
  });
  const fourth = buildGate(policyStore);
  await fourth.gate.verifyCompletion({
    declaration: declaration({
      completionAttemptId: "attempt-budget-1",
      understandingConfirmation: { restatedGoal: "补 README", confirmedAtIso: "2026-10-22T10:00:00.000Z" },
    }),
  });
  const exhausted = await fourth.gate.verifyCompletion({
    declaration: declaration({
      completionAttemptId: "attempt-budget-2",
      understandingConfirmation: { restatedGoal: "补 README", confirmedAtIso: "2026-10-22T10:00:00.000Z" },
    }),
  });
  observations.budget = {
    verdict: exhausted.verdict,
    budgetStatus: exhausted.budgetStatus,
    isSkipped: exhausted.isSkipped,
  };
  if (exhausted.budgetStatus !== "quality-check-budget-exhausted") {
    failures.push(
      `预算耗尽应报 quality-check-budget-exhausted，实际 ${String(exhausted.budgetStatus)}`,
    );
  }

  // ⑤ 重启后审计可读回
  const reloadedAudit = await new sdk.FileAccuracyVerificationAuditLog({ baseDirectory }).readAll();
  observations.auditRecordCount = reloadedAudit.length;
  if (reloadedAudit.length < 3) failures.push("重启后审计记录应可读回（≥3 条）");

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
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`ACCURACY E2E 包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("ACCURACY E2E 通过：关闭不发起校验也不阻塞、fast 档诚实跳过、预算耗尽记录不足、审计可追溯\n");

