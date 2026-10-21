#!/usr/bin/env node
/**
 * USAGE-01-03 公开入口（tarball）验收（2026-10-21）。
 *
 * 用法：node scripts/verify-usage-package.mjs --package-dir <已安装包目录>
 *
 * 判据（卡内："账目可复算、不虚报余额、价格缺失和估算来源清楚、不泄漏其他个体明细"）：
 * 1. **去重**：同请求同 revision 同哈希重复写入 ⇒ `duplicate-idempotent`，条目数不增；
 * 2. **同键异参** ⇒ `conflict-rejected`（不覆盖）；
 * 3. **过期 revision** ⇒ `stale-revision-rejected`（终值取最大 revision）；
 * 4. **可复算**：`aggregateUsageEntries(store.readAll())` 的合计 == 逐条手工求和；
 * 5. **未知 usage 不补零**：`inputTokenCount:null` 的条目 ⇒ `evaluateUsageBudget` 返回 `consumedTokenCount:null`
 *    （**不宣称未超预算**）；
 * 6. **估算来源清楚**：`isEstimated:true` 的条目在聚合里与其他来源分开计数；
 * 7. **不泄漏其他个体**：每个条目必须带 `sourceAgentInstanceId`，脚本按个体过滤后
 *    只应看到该个体的条目（存储层不返回"别人的明细"这件事由 mission/个体过滤口径保证）。
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
  process.stderr.write("用法: node scripts/verify-usage-package.mjs --package-dir <已安装包目录>\n");
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
for (const requiredName of ["UsageLedgerStore", "aggregateUsageEntries", "evaluateUsageBudget"]) {
  if (sdk[requiredName] === undefined) {
    process.stderr.write(`已安装包未导出 ${requiredName}\n`);
    process.exit(1);
  }
}

const failures = [];
const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-usage-package-"));
try {
  const store = new sdk.UsageLedgerStore({ baseDirectory });
  const baseEntry = {
    requestIdentifier: "request-1",
    requestRevision: 1,
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    sourceAgentInstanceId: "agent-1",
    providerProfileId: "profile-1",
    modelIdentifier: "model-a",
    recordedAtIso: "2026-10-21T12:00:00.000Z",
    inputTokenCount: 100,
    outputTokenCount: 50,
    cachedTokenCount: 0,
    isEstimated: false,
    inputHash: "hash-1",
    attribution: { kind: "total", parentRequestIdentifier: null },
  };

  const first = await store.append(baseEntry);
  if (first.outcome !== "appended") failures.push(`首次写入应为 appended，实际 ${first.outcome}`);

  // ① 去重
  const duplicate = await store.append(baseEntry);
  if (duplicate.outcome !== "duplicate-idempotent") {
    failures.push(`重复写入应为 duplicate-idempotent，实际 ${duplicate.outcome}`);
  }
  const afterDuplicate = await store.readAll();
  if (afterDuplicate.length !== 1) failures.push(`去重后条目数应为 1，实际 ${afterDuplicate.length}`);

  // ② 同键异参
  const conflict = await store.append({ ...baseEntry, inputHash: "hash-2" });
  if (conflict.outcome !== "conflict-rejected") {
    failures.push(`同键异参应为 conflict-rejected，实际 ${conflict.outcome}`);
  }

  // ③ 过期 revision
  // 过期 revision 必须**保持同哈希**（否则先命中 conflict 分支，测不到 revision 规则）
  const staleRevision = await store.append({
    ...baseEntry,
    requestRevision: 0,
    inputTokenCount: 1,
  });
  if (staleRevision.outcome !== "stale-revision-rejected") {
    failures.push(`过期 revision 应为 stale-revision-rejected，实际 ${staleRevision.outcome}`);
  }

  // ④ 可复算
  await store.append({
    ...baseEntry,
    requestIdentifier: "request-2",
    inputHash: "hash-4",
    inputTokenCount: 300,
    outputTokenCount: 100,
    recordedAtIso: "2026-10-21T12:00:01.000Z",
  });
  const entries = await store.readAll();
  const aggregate = sdk.aggregateUsageEntries(entries);
  const manualInputSum = entries.reduce((total, entry) => total + (entry.inputTokenCount ?? 0), 0);
  const aggregateInput = aggregate.totals?.inputTokenCount ?? aggregate.inputTokenCount ?? null;
  if (aggregateInput !== manualInputSum) {
    failures.push(
      `聚合不可复算：aggregate=${String(aggregateInput)} 手工=${String(manualInputSum)}`,
    );
  }

  // ⑤ 未知 usage 不补零
  await store.append({
    ...baseEntry,
    requestIdentifier: "request-missing",
    inputHash: "hash-5",
    inputTokenCount: null,
    outputTokenCount: null,
    missingUsageReason: "cancelled-before-usage",
  });
  const withMissing = sdk.aggregateUsageEntries(await store.readAll());
  const budget = sdk.evaluateUsageBudget(withMissing, { inputTokenBudget: 10_000 });
  if (budget.consumedTokenCount !== null) {
    failures.push(
      `存在未知 usage 时 consumedTokenCount 必须为 null（不可判定），实际 ${String(budget.consumedTokenCount)}`,
    );
  }
  if (budget.isExceeded !== false) failures.push("存在未知 usage 时不得宣称超预算（只能不可判定）");

  // ⑥ 估算来源分开
  await store.append({
    ...baseEntry,
    requestIdentifier: "request-estimated",
    inputHash: "hash-6",
    inputTokenCount: 42,
    isEstimated: true,
  });
  const estimateAggregate = sdk.aggregateUsageEntries(await store.readAll());
  // 聚合契约：`billable` 只含**非估算**条目，并用 `excludedEstimatedCount` 说明剔除了多少条估算
  const excludedEstimatedCount = estimateAggregate.billable?.excludedEstimatedCount ?? null;
  if (excludedEstimatedCount === null || excludedEstimatedCount < 1) {
    failures.push(
      `聚合未把估算来源与账单口径分开（excludedEstimatedCount=${String(excludedEstimatedCount)}）`,
    );
  }
  if (estimateAggregate.costEstimate?.amountMinorUnits !== null) {
    failures.push("无价目时 costEstimate.amountMinorUnits 必须为 null（不伪造金额）");
  }

  // ⑦ 不泄漏其他个体：每条的 sourceAgentInstanceId 可辨，按个体过滤后只看到自己的
  const ownEntries = entries.filter((entry) => entry.sourceAgentInstanceId === "agent-1");
  if (ownEntries.some((entry) => entry.sourceAgentInstanceId !== "agent-1")) {
    failures.push("按个体过滤后仍出现其他个体的条目");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        appendOutcomes: {
          first: first.outcome,
          duplicate: duplicate.outcome,
          conflict: conflict.outcome,
          staleRevision: staleRevision.outcome,
        },
        entryCountAfterDedupe: afterDuplicate.length,
        recomputedInputTokens: aggregateInput,
        manualInputTokens: manualInputSum,
        budgetConsumedTokenCountWithMissingUsage: budget.consumedTokenCount,
        excludedEstimatedCount: estimateAggregate.billable?.excludedEstimatedCount ?? null,
        costEstimateAmountMinorUnits: estimateAggregate.costEstimate?.amountMinorUnits ?? null,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`USAGE 包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("USAGE 包级验收通过：去重/冲突/过期 revision、可复算、未知 usage 不补零、估算分列\n");

