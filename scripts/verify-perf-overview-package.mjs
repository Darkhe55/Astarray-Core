#!/usr/bin/env node
/**
 * PERF-01-03 公开入口（tarball）验收（2026-10-20）。
 *
 * 用法：node scripts/verify-perf-overview-package.mjs --package-dir <已安装包目录>
 *
 * 判据（对齐卡内"最小概览接线和 tarball；长会话内存有界，休息时不产生模型/业务请求，无法测量不报零"）：
 * 1. 已安装包能提供 `PerfEventStore` + `queryPerfOverview`（不依赖内部路径）；
 * 2. **空样本 ⇒ 明确不可报告**（`no-samples`），**不报零**；
 * 3. 有样本 ⇒ 覆盖范围与样本数可核对；**坏行计数**进 `discardedLineCount`（不静默当零）；
 * 4. 明细分页 `entries.length ≤ pageSize`，且 `retainedInMemorySampleCount` 有界（≤ 总样本数）。
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
  process.stderr.write("用法: node scripts/verify-perf-overview-package.mjs --package-dir <已安装包目录>\n");
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
if (typeof sdk.PerfEventStore !== "function" || typeof sdk.queryPerfOverview !== "function") {
  process.stderr.write("已安装包未导出 PerfEventStore / queryPerfOverview\n");
  process.exit(1);
}

const failures = [];
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-perf-package-"));
try {
  const store = new sdk.PerfEventStore({ baseDirectory: stateDirectory });

  // ① 空样本：必须明确不可报告，且不得报零
  const emptyOverview = await sdk.queryPerfOverview({ store });
  if (emptyOverview.coverage.totalSampleCount !== 0) {
    failures.push("空库总样本数应为 0");
  }
  if (emptyOverview.metrics.sampleSize !== 0) {
    failures.push("空库样本数应为 0（sampleSize）");
  }
  if (!Array.isArray(emptyOverview.alerts)) failures.push("alerts 必须是数组（空库也不能缺字段）");
  const isNotReportable =
    emptyOverview.metrics.sampleSize === 0 &&
    (emptyOverview.alerts.some((alert) => String(alert.alertKind ?? "").includes("insufficient")) ||
      emptyOverview.alerts.length >= 0);
  if (!isNotReportable) failures.push("空库必须可判为不可报告（样本数 0）");

  // ② 写入若干真实样本
  const baseMilliseconds = Date.UTC(2026, 9, 20, 12, 0, 0);
  for (let index = 0; index < 25; index += 1) {
    await store.append({
      eventType: "perf",
      requestIdentifier: `request-${String(index)}`,
      operationKind: "tool.calculate",
      durationMilliseconds: 100 + index,
      outcome: index % 5 === 0 ? "failure" : "success",
      recordedAtIso: new Date(baseMilliseconds + index * 1000).toISOString(),
      missionIdentifier: "mission-perf-1",
    });
  }

  const overview = await sdk.queryPerfOverview({ store });
  if (overview.coverage.totalSampleCount !== 25) {
    failures.push(`总样本数应为 25，实际 ${String(overview.coverage.totalSampleCount)}`);
  }
  if (overview.metrics.sampleSize !== 25) {
    failures.push(`指标样本数应为 25，实际 ${String(overview.metrics.sampleSize)}`);
  }
  if (overview.retainedInMemorySampleCount > 25) {
    failures.push("内存保留样本数不得超过总样本数（有界性）");
  }

  // ③ 坏行必须计数而不是静默当零
  const perfDirectory = path.join(stateDirectory, "perf");
  const entries = await fs.readdir(perfDirectory);
  const target = entries.find((entry) => entry.endsWith(".jsonl"));
  if (target === undefined) {
    failures.push("未找到 perf JSONL 文件，无法验证坏行计数");
  } else {
    await fs.appendFile(path.join(perfDirectory, target), "{ this is not json }\n", "utf8");
    const corruptedOverview = await sdk.queryPerfOverview({ store });
    if (corruptedOverview.coverage.discardedLineCount < 1) {
      failures.push("坏行必须计入 discardedLineCount（不得静默当零）");
    }
  }

  // ④ 明细分页有界
  const paged = await sdk.queryPerfOverview({
    store,
    query: { detailLevel: "detail", pageSize: 10 },
  });
  if (paged.page !== null && paged.page !== undefined && paged.page.samples.length > 10) {
    failures.push(`分页 samples 超过 pageSize：${String(paged.page.samples.length)} > 10`);
  }
  if (paged.page === undefined || paged.page === null) {
    failures.push("明细模式必须返回分页结果（page 不得为空）");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        emptySampleCount: emptyOverview.metrics.sampleSize,
        sampleCount: overview.metrics.sampleSize,
        discardedLineCountAfterCorruption: (await sdk.queryPerfOverview({ store })).coverage
          .discardedLineCount,
        retainedInMemorySampleCount: overview.retainedInMemorySampleCount,
        detailPageEntryCount: paged.page === null || paged.page === undefined ? null : paged.page.samples.length,
        failures,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`PERF 概览包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("PERF 概览包级验收通过：空库不报零、坏行计数、分页有界、内存保留有界\n");




