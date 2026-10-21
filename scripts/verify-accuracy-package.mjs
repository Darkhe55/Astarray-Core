#!/usr/bin/env node
/**
 * ACCURACY-01/02 公开入口（tarball）对账验收（2026-10-21）。
 *
 * 用法：node scripts/verify-accuracy-package.mjs --package-dir <已安装包目录>
 *
 * 卡内判据（ACCURACY-01/02）：
 * - 核查**未来 revision**、**漏报必需节点**、**空证据**及**部分完成**；
 * - 反例：**错收件人**、**重复派发**（幂等签收）、**旧版本**、**伪造证据**、**陈旧产物**、崩溃重启；
 * - **先证明缺口，不重复实现已有能力**。
 *
 * 因此本脚本做的是**对账**：逐条验证既有 `TaskAccuracyVerifier` 是否真覆盖这些反例，
 * 并把"通过/缺口"如实打出来；发现缺口就让门禁红（不粉饰）。
 */
import { promises as fs } from "node:fs";
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
  process.stderr.write("用法: node scripts/verify-accuracy-package.mjs --package-dir <已安装包目录>\n");
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
for (const requiredName of ["TaskAccuracyVerifier", "ACCURACY_TIERS", "resolveAccuracyTier"]) {
  if (sdk[requiredName] === undefined) {
    process.stderr.write(`已安装包未导出 ${requiredName}\n`);
    process.exit(1);
  }
}

const failures = [];
const checked = [];
const processed = new Map();

/** 构造一个可配置的验器（内存端口）。 */
function buildVerifier(overrides = {}) {
  const config = {
    requiredEntries: [
      { entryIdentifier: "entry-1", description: "必需 1", isRequired: true, evidenceRequirement: "artifact" },
      { entryIdentifier: "entry-2", description: "必需 2", isRequired: true, evidenceRequirement: "any" },
      { entryIdentifier: "entry-optional", description: "可选", isRequired: false, evidenceRequirement: "any" },
    ],
    currentRevision: 3,
    expectedRecipient: "main-agent-1",
    tier: "standard",
    isClarificationRequired: false,
    // 真实契约：EvidenceReference 没有 artifactIdentifier，用 contentHash 区分新鲜/陈旧产物
    revisionByContentHash: new Map([["sha256:fresh", 3], ["sha256:stale", 5]]),
    ...overrides,
  };
  return new sdk.TaskAccuracyVerifier({
    getCurrentTaskSequenceRevision: async () => config.currentRevision,
    getRequiredAcceptanceEntries: async () => config.requiredEntries,
    getArtifactRevision: async (evidence) =>
      typeof evidence.contentHash === "string" ? (config.revisionByContentHash.get(evidence.contentHash) ?? null) : null,
    getExpectedRecipientIdentifier: async () => config.expectedRecipient,
    getTier: async () => config.tier,
    isClarificationRequired: async () => config.isClarificationRequired,
    findProcessedAttempt: async (attemptId) => processed.get(attemptId) ?? null,
    recordProcessedAttempt: async (attemptId, result) => {
      processed.set(attemptId, result);
    },
  });
}

function declaration(overrides = {}) {
  return {
    taskIdentifier: "task-1",
    completionAttemptId: "attempt-1",
    taskSequenceRevision: 3,
    completedEntryIdentifiers: ["entry-1", "entry-2"],
    evidenceReferences: [
      {
        evidenceIdentifier: "evidence-fresh",
        entryIdentifier: "entry-1",
        evidenceKind: "test-report",
        contentHash: "sha256:fresh",
        producedAtRevision: 3,
        producedByAgentInstanceId: "agent-1",
        observedAtIso: "2026-10-21T12:00:00.000Z",
      },
    ],
    understandingConfirmation: null,
    deliveredToRecipientIdentifier: "main-agent-1",
    ...overrides,
  };
}

// ① 档位常量
checked.push({ check: "tiers", value: [...sdk.ACCURACY_TIERS] });
if (JSON.stringify([...sdk.ACCURACY_TIERS]) !== JSON.stringify(["fast", "standard", "strict"])) {
  failures.push("ACCURACY_TIERS 应恰为 fast/standard/strict");
}

// ② 正常声明（standard）⇒ accepted
const accepted = await buildVerifier().verifyCompletion(declaration({ completionAttemptId: "attempt-accepted" }));
checked.push({ check: "standard-accepted", verdict: accepted.verdict });
if (accepted.verdict !== "accepted") {
  failures.push(`完整声明应 accepted，实际 ${accepted.verdict}（${accepted.reasons.join("; ")}）`);
}

// ③ 漏报必需节点 ⇒ rejected
const missingEntry = await buildVerifier().verifyCompletion(
  declaration({ completionAttemptId: "attempt-missing", completedEntryIdentifiers: ["entry-1"] }),
);
checked.push({ check: "missing-entry", verdict: missingEntry.verdict, missing: missingEntry.missingRequiredEntryIdentifiers });
if (missingEntry.verdict !== "rejected" || !missingEntry.missingRequiredEntryIdentifiers.includes("entry-2")) {
  failures.push(`漏报必需节点应 rejected 且指出 entry-2，实际 ${JSON.stringify(missingEntry)}`);
}

// ④ 空证据 ⇒ rejected（不得只凭自述）
const emptyEvidence = await buildVerifier().verifyCompletion(
  declaration({ completionAttemptId: "attempt-empty-evidence", evidenceReferences: [] }),
);
checked.push({ check: "empty-evidence", verdict: emptyEvidence.verdict });
if (emptyEvidence.verdict !== "rejected") {
  failures.push(`空证据应 rejected，实际 ${emptyEvidence.verdict}`);
}

// ⑤ 错收件人 ⇒ rejected
const wrongRecipient = await buildVerifier().verifyCompletion(
  declaration({ completionAttemptId: "attempt-wrong-recipient", deliveredToRecipientIdentifier: "someone-else" }),
);
checked.push({ check: "wrong-recipient", reasons: wrongRecipient.reasons });
if (wrongRecipient.verdict !== "rejected" || !wrongRecipient.reasons.some((reason) => reason.includes("wrong-recipient"))) {
  failures.push("错收件人应 rejected 且原因含 wrong-recipient");
}

// ⑥ 旧 revision ⇒ rejected；未来 revision ⇒ 明确处理（不当作正常）
const staleRevision = await buildVerifier().verifyCompletion(
  declaration({ completionAttemptId: "attempt-stale-revision", taskSequenceRevision: 1 }),
);
checked.push({ check: "stale-revision", verdict: staleRevision.verdict });
if (staleRevision.verdict !== "rejected") failures.push("旧 revision 应 rejected");

const futureRevision = await buildVerifier().verifyCompletion(
  declaration({ completionAttemptId: "attempt-future-revision", taskSequenceRevision: 99 }),
);
checked.push({ check: "future-revision", verdict: futureRevision.verdict, reasons: futureRevision.reasons });
if (futureRevision.verdict === "accepted") {
  failures.push("未来 revision 不得被接受（卡内点名核查未来 revision）");
}

// ⑦ 伪造证据（未知 artifact）⇒ rejected 且列入 forged
const forged = await buildVerifier().verifyCompletion(
  declaration({
    completionAttemptId: "attempt-forged",
    evidenceReferences: [{ entryIdentifier: "entry-1", artifactIdentifier: "artifact-forged", evidenceKind: "test-receipt" }],
  }),
);
checked.push({ check: "forged-evidence", verdict: forged.verdict, forged: forged.forgedEvidenceIdentifiers });
if (forged.verdict !== "rejected" || forged.forgedEvidenceIdentifiers.length === 0) {
  failures.push("伪造证据应 rejected 且被列入 forgedEvidenceIdentifiers");
}

// ⑧ 陈旧产物 ⇒ rejected 且列入 stale
const staleArtifact = await buildVerifier().verifyCompletion(
  declaration({
    completionAttemptId: "attempt-stale-artifact",
    evidenceReferences: [
      {
        evidenceIdentifier: "evidence-stale",
        entryIdentifier: "entry-1",
        evidenceKind: "test-report",
        contentHash: "sha256:stale",
        producedAtRevision: 1,
        producedByAgentInstanceId: "agent-1",
        observedAtIso: "2026-10-21T12:00:00.000Z",
      },
    ],
  }),
);
checked.push({ check: "stale-artifact", verdict: staleArtifact.verdict, stale: staleArtifact.staleEvidenceIdentifiers });
if (staleArtifact.verdict !== "rejected" || staleArtifact.staleEvidenceIdentifiers.length === 0) {
  failures.push("陈旧产物应 rejected 且被列入 staleEvidenceIdentifiers");
}

// ⑧b 漏传 contentHash（畸形证据）⇒ 必须 rejected 且**不崩溃**（本次加固点）
const malformedEvidence = await buildVerifier().verifyCompletion(
  declaration({
    completionAttemptId: "attempt-malformed-evidence",
    evidenceReferences: [
      {
        evidenceIdentifier: "evidence-malformed",
        entryIdentifier: "entry-1",
        evidenceKind: "test-report",
        producedAtRevision: 3,
        producedByAgentInstanceId: "agent-1",
        observedAtIso: "2026-10-21T12:00:00.000Z",
      },
    ],
  }),
);
checked.push({ check: "malformed-evidence", verdict: malformedEvidence.verdict });
if (malformedEvidence.verdict !== "rejected") {
  failures.push("漏传 contentHash 的畸形证据应 rejected（不得崩溃、不得 accepted）");
}

// ⑨ 幂等签收：同 completionAttemptId 再提交 ⇒ isIdempotentReplay=true，结论一致
const replay = await buildVerifier().verifyCompletion(declaration({ completionAttemptId: "attempt-accepted" }));
checked.push({ check: "idempotent-replay", replay: replay.isIdempotentReplay, verdict: replay.verdict });
if (replay.isIdempotentReplay !== true || replay.verdict !== accepted.verdict) {
  failures.push("重复提交同一次完成声明应幂等复用结论（isIdempotentReplay=true）");
}

// ⑩ fast 档：跳过质量检查但状态诚实（不得写成通过）
const fast = await buildVerifier({ tier: "fast" }).verifyCompletion(
  declaration({ completionAttemptId: "attempt-fast" }),
);
checked.push({ check: "fast-tier", verdict: fast.verdict });
if (fast.verdict === "accepted") {
  failures.push("fast 档不得把结果写成 accepted（卡内：记录“质量检查已跳过”，不能写成测试/验收通过）");
}

// ⑪ strict 档：缺理解确认 ⇒ rejected
const strictMissingConfirmation = await buildVerifier({ tier: "strict" }).verifyCompletion(
  declaration({ completionAttemptId: "attempt-strict-missing" }),
);
checked.push({ check: "strict-missing-confirmation", verdict: strictMissingConfirmation.verdict });
if (strictMissingConfirmation.verdict !== "rejected") {
  failures.push("strict 档缺理解确认应 rejected");
}
const strictWithConfirmation = await buildVerifier({ tier: "strict" }).verifyCompletion(
  declaration({
    completionAttemptId: "attempt-strict-ok",
    understandingConfirmation: { restatedGoal: "补齐 README 安装步骤", confirmedAtIso: "2026-10-21T12:00:00.000Z" },
  }),
);
checked.push({ check: "strict-with-confirmation", verdict: strictWithConfirmation.verdict });
if (strictWithConfirmation.verdict !== "accepted") {
  failures.push(`strict 档带理解确认应 accepted，实际 ${strictWithConfirmation.verdict}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      checked,
      failures,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  process.stderr.write(`ACCURACY 对账失败：${String(failures.length)} 项缺口\n`);
  process.exit(1);
}
process.stdout.write("ACCURACY 对账通过：漏报/空证据/错收件人/旧或未来 revision/伪造/陈旧/幂等/档位诚实均成立\n");

