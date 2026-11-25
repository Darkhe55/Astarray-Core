#!/usr/bin/env node
/**
 * B9 覆盖率缺口报告（2026-11-25）。
 *
 * 用途：`npm run test:coverage` 默认只输出汇总；本脚本读取
 * `coverage/coverage-final.json`（需 `--coverage.reporter=json`），
 * 按文件/行汇总**未覆盖的分支槽位**，用于把补测预算放到杠杆最大的位置。
 *
 * 用法：
 *   node scripts/report-coverage-gaps.mjs                     # 全仓库 Top 20 文件
 *   node scripts/report-coverage-gaps.mjs --file <子串>        # 指定文件的行级缺口
 *   node scripts/report-coverage-gaps.mjs --top 30            # 调整文件数
 *
 * 只读：不写文件、不跑测试、不改覆盖率配置。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function parseArguments(argv) {
  const options = { top: 20, file: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--top") {
      options.top = Number.parseInt(argv[index + 1] ?? "20", 10);
      index += 1;
    } else if (argument === "--file") {
      options.file = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const coveragePath = path.join(process.cwd(), "coverage", "coverage-final.json");
if (!existsSync(coveragePath)) {
  console.error(
    "缺少 coverage/coverage-final.json：先运行 `npx vitest run --coverage --coverage.reporter=json`。",
  );
  process.exit(1);
}

const finalCoverage = JSON.parse(readFileSync(coveragePath, "utf8"));

function uncoveredSlotsFor(data) {
  const slots = [];
  for (const [branchIdentifier, counts] of Object.entries(data.b)) {
    const branchMeta = data.branchMap[branchIdentifier];
    for (let index = 0; index < counts.length; index += 1) {
      if (counts[index] !== 0) continue;
      const location = branchMeta.locations[index] ?? branchMeta.loc;
      slots.push({ line: location.start.line, type: branchMeta.type });
    }
  }
  return slots;
}

const rows = [];
for (const [filePath, data] of Object.entries(finalCoverage)) {
  const slots = uncoveredSlotsFor(data);
  if (slots.length === 0) continue;
  const relativePath = path
    .relative(process.cwd(), filePath)
    .split(path.sep)
    .join("/");
  rows.push({ filePath: relativePath, slots });
}
rows.sort((left, right) => right.slots.length - left.slots.length);

if (options.file === null) {
  console.log(`未覆盖分支槽位合计: ${rows.reduce((sum, row) => sum + row.slots.length, 0)}`);
  for (const row of rows.slice(0, options.top)) {
    console.log(`${String(row.slots.length).padStart(5)}  ${row.filePath}`);
  }
} else {
  const matching = rows.filter((row) => row.filePath.includes(options.file));
  if (matching.length === 0) {
    console.log(`没有匹配 ${options.file} 的未覆盖分支。`);
  }
  for (const row of matching) {
    const byLine = new Map();
    for (const slot of row.slots) {
      byLine.set(slot.line, (byLine.get(slot.line) ?? 0) + 1);
    }
    const sorted = [...byLine.entries()].sort((left, right) => right[1] - left[1]);
    console.log(`${row.filePath}: ${row.slots.length} 个未覆盖槽位`);
    for (const [line, count] of sorted.slice(0, 60)) {
      console.log(`${String(count).padStart(4)}  line ${line}`);
    }
  }
}
