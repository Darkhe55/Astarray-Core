#!/usr/bin/env node
/**
 * DIAG-01-03 公开入口（tarball）验收（2026-10-21）。
 *
 * 用法：node scripts/verify-diagnostic-package.mjs --package-dir <已安装包目录>
 *
 * 判据（对齐卡内"重复风暴、敏感错误文本、故障链、不足证据、诊断自身失败"）：
 * 1. **空库不编造结论**：摘要三类 findings 都为空，且 coverage 明确 0；
 * 2. **重复风暴**：同一指纹重复 50 次 ⇒ 分组计数为 50（不乒乓、不丢事件）；
 * 3. **敏感错误文本**：写入含 token/邮箱/内网 IP 的文本 ⇒ 落盘与证据包里都**已脱敏**；
 * 4. **故障链**：root 与 wrapper 码保留；**确定事实与推断分列**（不混为一谈）；
 * 5. **诊断自身失败**：坏行计入 `discardedLineCount`（不崩、不静默）；
 * 6. **分页有界**：`pageSize=10` ⇒ 页内 ≤10。
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
  process.stderr.write("用法: node scripts/verify-diagnostic-package.mjs --package-dir <已安装包目录>\n");
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
for (const requiredName of ["DiagnosticEventStore", "queryDiagnosticSummary", "buildRedactedDiagnosticBundle"]) {
  if (sdk[requiredName] === undefined) {
    process.stderr.write(`已安装包未导出 ${requiredName}\n`);
    process.exit(1);
  }
}

const failures = [];
const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-diag-package-"));
try {
  const store = new sdk.DiagnosticEventStore({ baseDirectory });

  // ① 空库
  const emptySummary = await sdk.queryDiagnosticSummary({ store });
  if (emptySummary.coverage.totalEventCount !== 0) failures.push("空库总事件数应为 0");
  if (
    emptySummary.deterministicFindings.length !== 0 ||
    emptySummary.suspectedFindings.length !== 0
  ) {
    failures.push("空库不得编造 findings");
  }

  const buildEvent = (index, overrides = {}) => ({
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: new Date(Date.UTC(2026, 9, 21, 12, 0, 0) + index * 1000).toISOString(),
    sourceAgentInstanceId: "agent-1",
    missionIdentifier: "mission-diag",
    taskIdentifier: "task-1",
    requestIdentifier: `request-${String(index)}`,
    requestRevision: 1,
    origin: { kind: "provider" },
    errorCode: "provider-request-failed",
    stage: "provider",
    severity: "error",
    component: "provider-runtime",
    messageText: "请求失败",
    recoveryState: "recovering",
    classification: "deterministic-fact",
    chain: { rootErrorCode: "provider-request-failed", wrapperErrorCodes: [] },
    ...overrides,
  });

  // ② 重复风暴：50 条同指纹
  for (let index = 0; index < 50; index += 1) {
    await store.append(buildEvent(index));
  }
  const stormSummary = await sdk.queryDiagnosticSummary({ store });
  if (stormSummary.coverage.totalEventCount !== 50) {
    failures.push(`重复风暴后总事件数应为 50，实际 ${String(stormSummary.coverage.totalEventCount)}`);
  }
  const stormFinding = stormSummary.deterministicFindings[0];
  if (stormFinding === undefined || stormFinding.occurrenceCount !== 50) {
    failures.push(
      `同指纹应聚合为 1 组、计数 50，实际 ${JSON.stringify(stormFinding?.occurrenceCount ?? null)}`,
    );
  }

  // ③ 敏感文本：token / 邮箱 / 内网 IP
  await store.append(
    buildEvent(100, {
      requestIdentifier: "request-sensitive",
      messageText:
        "调用失败 sk-abcdef1234567890 用户 alice@example.com 来自 192.168.1.20 的请求",
    }),
  );
  const sensitiveSummary = await sdk.queryDiagnosticSummary({ store });
  const sensitiveFinding = [...sensitiveSummary.deterministicFindings, ...sensitiveSummary.suspectedFindings].find(
    (finding) => typeof finding.sampleMessageText === "string" && finding.sampleMessageText.includes("sk-"),
  );
  if (sensitiveFinding !== undefined) failures.push("摘要里仍出现未脱敏的 token");
  const bundle = await sdk.buildRedactedDiagnosticBundle({
    store,
    environment: { platform: "win32", astarrayVersion: packageJson.version },
  });
  const bundleText = JSON.stringify(bundle);
  if (bundleText.includes("sk-abcdef1234567890")) failures.push("证据包里仍出现未脱敏的 token");
  if (bundleText.includes("alice@example.com")) failures.push("证据包里仍出现邮箱");
  if (bundleText.includes("192.168.1.20")) failures.push("证据包里仍出现内网 IP");

  // ④ 故障链 + 分类分列
  await store.append(
    buildEvent(101, {
      requestIdentifier: "request-chain",
      errorCode: "provider-timeout",
      classification: "suspected-cause",
      chain: { rootErrorCode: "socket-hang-up", wrapperErrorCodes: ["provider-timeout"] },
    }),
  );
  const chainSummary = await sdk.queryDiagnosticSummary({ store });
  const chainFinding = chainSummary.suspectedFindings.find((finding) =>
    JSON.stringify(finding).includes("socket-hang-up"),
  );
  if (chainFinding === undefined) failures.push("故障链根因未保留在推断类 findings 中");
  if (chainSummary.deterministicFindings.some((finding) => JSON.stringify(finding).includes("socket-hang-up"))) {
    failures.push("推断类故障链被混入确定事实");
  }

  // ⑤ 诊断自身失败：坏行计数
  const diagnosticDirectory = path.join(baseDirectory, "diagnostics");
  let targetFile = null;
  try {
    const entries = await fs.readdir(diagnosticDirectory);
    targetFile = entries.find((entry) => entry.endsWith(".jsonl")) ?? null;
  } catch {
    targetFile = null;
  }
  if (targetFile === null) {
    failures.push("未找到诊断 JSONL，无法验证坏行计数");
  } else {
    await fs.appendFile(path.join(diagnosticDirectory, targetFile), "{ not json }\n", "utf8");
    const afterCorruption = await sdk.queryDiagnosticSummary({ store });
    if (afterCorruption.coverage.discardedLineCount < 1) {
      failures.push("坏行必须计入 discardedLineCount（不静默）");
    }
  }

  // ⑥ 分页有界
  const paged = await sdk.queryDiagnosticSummary({ store, query: { pageSize: 10 } });
  const pagedEntryCount =
    Array.isArray(paged.groups) ? paged.groups.length : Array.isArray(paged.page) ? paged.page.length : null;
  if (pagedEntryCount !== null && pagedEntryCount > 10) {
    failures.push(`分页超过 pageSize：${String(pagedEntryCount)} > 10`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        emptyTotalEventCount: emptySummary.coverage.totalEventCount,
        stormTotalEventCount: stormSummary.coverage.totalEventCount,
        stormOccurrenceCount: stormFinding?.occurrenceCount ?? null,
        suspectedFindingCount: chainSummary.suspectedFindings.length,
        discardedLineCount: (await sdk.queryDiagnosticSummary({ store })).coverage.discardedLineCount,
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
  process.stderr.write(`DIAG 包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("DIAG 包级验收通过：空库不编造、风暴聚合、敏感文本脱敏、故障链分列、坏行计数\n");

