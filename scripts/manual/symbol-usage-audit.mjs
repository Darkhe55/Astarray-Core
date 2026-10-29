#!/usr/bin/env node
/**
 * R44 (2026-10-29): read-only symbol-usage audit for the evidence index.
 *
 * For each symbol listed below it counts occurrences across TypeScript files under packages
 * and .mjs files under scripts, separates occurrences inside the defining file from occurrences
 * elsewhere, and prints a table. "definition-only" means the symbol is never referenced
 * outside its own file, which is worth a look but is NOT automatically a defect (an entry
 * point exported through the SDK may legitimately be referenced only by consumers).
 *
 * It reads source text only: no imports, no execution, no state.
 *
 * Usage (from astarray/):
 *   node scripts/manual/symbol-usage-audit.mjs
 *   node scripts/manual/symbol-usage-audit.mjs > docs/reports/SYMBOL_USAGE_AUDIT.md
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const entries = [
  { symbol: "GoalGateCache", file: "packages/core/src/orchestration/goal-gate-cache.ts" },
  { symbol: "GoalContractStore", file: "packages/core/src/orchestration/goal-contract-store.ts" },
  { symbol: "GoalMissionBindingStore", file: "packages/core/src/orchestration/goal-mission-binding-store.ts" },
  { symbol: "CompletionReceiptStore", file: "packages/core/src/orchestration/completion-receipt-store.ts" },
  { symbol: "CompletionVerdictStore", file: "packages/core/src/orchestration/completion-verdict-store.ts" },
  { symbol: "MissionSequenceBindingStore", file: "packages/core/src/orchestration/mission-sequence-binding-store.ts" },
  { symbol: "DeferredInsertionQueueStore", file: "packages/core/src/orchestration/deferred-insertion-queue.ts" },
  { symbol: "GoalDispatchVerdictJournal", file: "packages/core/src/orchestration/goal-dispatch-verdict-journal.ts" },
  { symbol: "inspectSingleTaskDispatchPrecheck", file: "packages/core/src/orchestration/task-ledger-bridge.ts" },
  { symbol: "buildWriteBackProposal", file: "packages/core/src/orchestration/task-ledger-bridge.ts" },
  { symbol: "assessGoalRequirementsFromLocalState", file: "packages/core/src/orchestration/goal-requirement-assessment.ts" },
  { symbol: "computeGoalPotential", file: "packages/core/src/orchestration/goal-contract.ts" },
  { symbol: "recordGroupCompletion", file: "packages/core/src/orchestration/goal-dispatch-gate.ts" },
  { symbol: "recordToolCallConsumed", file: "packages/core/src/orchestration/goal-dispatch-gate.ts" },
  { symbol: "sanitizeLogLine", file: "packages/core/src/infra/log-line-safety.ts" },
  { symbol: "recordPromptContentScan", file: "packages/core/src/orchestration/prompt-scan-journal.ts" },
  { symbol: "resolveGoalModeActivation", file: "packages/core/src/orchestration/goal-contract.ts" },
  { symbol: "saveActivated", file: "packages/core/src/orchestration/goal-contract-store.ts" },
  { symbol: "taskGroupBoundaryPort", file: "packages/core/src/orchestration/mission-orchestrator.ts" },
  { symbol: "completionReceiptReader", file: "packages/core/src/application/application-runtime.ts" },
  { symbol: "completionVerdictReader", file: "packages/core/src/application/application-runtime.ts" },
  { symbol: "createGoalContract", file: "packages/core/src/application/application-runtime.ts" },
  { symbol: "closeGoalExperiment", file: "packages/core/src/application/application-runtime.ts" },
  { symbol: "resultScanMode", file: "packages/core/src/bridge/mcp-tool-bridge.ts" },
  { symbol: "contentScan", file: "packages/core/src/orchestration/context-prompt-assembler.ts" },
  { symbol: "isSummaryView", file: "packages/tui/src/cli/task-ledger-command.ts" },
  { symbol: "isListBindings", file: "packages/tui/src/cli/task-ledger-command.ts" },
  { symbol: "executeGoalModeStatusCommand", file: "packages/tui/src/cli/goal-mode-command.ts" },
  { symbol: "executeGoalModeVerdictsCommand", file: "packages/tui/src/cli/goal-mode-command.ts" },
];

async function collectSourceFiles(directory) {
  const files = [];
  let entriesInDirectory;
  try {
    entriesInDirectory = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entriesInDirectory) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(entryPath)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
      files.push(entryPath);
    }
  }
  return files;
}

const sourceFiles = [
  ...(await collectSourceFiles(path.join(process.cwd(), "packages"))),
  ...(await collectSourceFiles(path.join(process.cwd(), "scripts"))),
];
const contentsByFile = new Map();
for (const filePath of sourceFiles) {
  contentsByFile.set(filePath, await readFile(filePath, "utf8"));
}

const rows = [];
for (const entry of entries) {
  const pattern = new RegExp(`\\b${entry.symbol}\\b`, "g");
  let total = 0;
  let insideDefiningFile = 0;
  const referencingFiles = new Set();
  for (const [filePath, content] of contentsByFile) {
    const matches = content.match(pattern);
    if (matches === null) {
      continue;
    }
    total += matches.length;
    const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
    if (relativePath === entry.file) {
      insideDefiningFile += matches.length;
    } else {
      referencingFiles.add(relativePath);
    }
  }
  rows.push({
    ...entry,
    total,
    insideDefiningFile,
    externalReferenceCount: referencingFiles.size,
    referencingFiles: [...referencingFiles].sort(),
  });
}

process.stdout.write(
  "> 由只读脚本 `scripts/manual/symbol-usage-audit.mjs` 生成；只统计源码文本出现次数，**不验证行为**。\n\n",
);
process.stdout.write(
  "| 符号 | 定义文件 | 总出现 | 定义文件内 | 外部引用文件数 | 判定 |\n|---|---|---|---|---|---|\n",
);
for (const row of rows) {
  const verdict =
    row.total === 0
      ? "**未找到**"
      : row.externalReferenceCount === 0
        ? "仅定义处（需人工确认）"
        : "有外部引用";
  process.stdout.write(
    `| \`${row.symbol}\` | ${row.file} | ${row.total} | ${row.insideDefiningFile} | ` +
      `${row.externalReferenceCount} | ${verdict} |\n`,
  );
}

const missing = rows.filter((row) => row.total === 0);
const definitionOnly = rows.filter(
  (row) => row.total > 0 && row.externalReferenceCount === 0,
);
process.stdout.write(
  `\n合计 ${rows.length} 个符号：未找到 ${missing.length} 个，仅定义处 ${definitionOnly.length} 个，有外部引用 ` +
    `${rows.filter((row) => row.externalReferenceCount > 0).length} 个。\n`,
);
if (missing.length > 0) {
  process.stdout.write(
    `\n**未找到**：${missing.map((row) => row.symbol).join("、")}（索引可能过期）。\n`,
  );
}
if (definitionOnly.length > 0) {
  process.stdout.write(
    "\n仅定义处不等于缺陷：例如只经 SDK 暴露的入口在仓内可能无人调用；但**入口本身不可达**时值得核对。\n",
  );
}
