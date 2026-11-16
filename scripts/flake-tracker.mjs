/**
 * 门禁抖动追踪（2026-11-16）。
 *
 * 为什么需要它：全量门禁长期存在"偶发翻红但隔离重跑必绿"的现象，此前只能靠人工重跑。
 * 本脚本把"重复跑同一批文件"变成可复算数据：每个文件跑 N 次，记录通过/失败、耗时，
 * 产出 `docs/reports/FLAKE_TRACKER_<date>.json`。
 *
 * 用法：
 *   node scripts/flake-tracker.mjs --files a.test.ts,b.test.ts --runs 5
 *   node scripts/flake-tracker.mjs --runs 3            # 缺省跑已知抖动集
 *
 * 说明：脚本只跑 vitest，不改生产代码、不改测试断言；失败文件按原样记录。
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 历次门禁里实际出现过的抖动文件（人工记录，非穷举）。 */
const KNOWN_FLAKY_FILES = [
  "tests/core/integration/anthropic-messages-runtime.test.ts",
  "tests/core/integration/anthropic-tool-loop-failclosed.test.ts",
  "tests/core/integration/completion-gate-counterexamples.test.ts",
  "tests/core/integration/graph-change-deterministic-drill.test.ts",
  "tests/core/integration/g4-tool-documentation-e2e.test.ts",
];

function parseArguments(argv) {
  const options = { files: KNOWN_FLAKY_FILES, runs: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--files" && typeof argv[index + 1] === "string") {
      options.files = argv[index + 1].split(",").map((value) => value.trim()).filter(Boolean);
      index += 1;
    } else if (argument === "--runs" && typeof argv[index + 1] === "string") {
      options.runs = Math.max(1, Number.parseInt(argv[index + 1], 10) || 1);
      index += 1;
    }
  }
  return options;
}

function runOnce(testFile) {
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(process.execPath, ["./node_modules/vitest/vitest.mjs", "run", testFile], {
    cwd: process.cwd(),
    encoding: "utf8",
    /** Windows 上 spawnSync 默认会弹窗，这里显式关闭。 */
    windowsHide: true,
  });
  const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const output = String(result.stdout ?? "") + String(result.stderr ?? "");
  return {
    isPassed: result.status === 0,
    exitCode: result.status,
    elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(2)),
    /** 只留诊断所需的尾部，避免把整段输出塞进报告。 */
    tail: output.trim().split(/\r?\n/u).slice(-6).join("\n"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = {
    reportIdentifier: "FLAKE_TRACKER",
    generatedAtIso: new Date().toISOString(),
    runsPerFile: options.runs,
    files: [],
  };

  for (const testFile of options.files) {
    const attempts = [];
    for (let index = 0; index < options.runs; index += 1) {
      attempts.push(runOnce(testFile));
    }
    const failureCount = attempts.filter((attempt) => !attempt.isPassed).length;
    report.files.push({
      testFile,
      runs: attempts.length,
      failureCount,
      failureRate: Number((failureCount / attempts.length).toFixed(4)),
      attempts,
    });
    console.log(
      `${failureCount === 0 ? "stable  " : "FLAKY   "} ${testFile}  失败 ${failureCount}/${attempts.length}`,
    );
  }

  const reportDirectory = path.join(process.cwd(), "docs", "reports");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, "FLAKE_TRACKER_2026-11-16.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n报告：${reportPath}`);
}

await main();
