#!/usr/bin/env node
/**
 * HISTORY-01-04 长历史资源测量（2026-10-20，公开库）。
 *
 * 卡内要求："资源测量"——用户能找到旧指令/失败调用/模型说明，**查看不重执行工具、不新增模型上下文**，
 * 且长历史下**内存/耗时有界**。本脚本只测**读路径**（`buildRunHistoryTimelinePage`）：
 *
 * 1. 用真实 `RunHistoryStore` 写入 N 条事件（默认 20,000），生成真实文件；
 * 2. 测：首页、锚点页（跳到中间）、关键词检索页 的耗时与 `heapUsed` 差值；
 * 3. 判据：**每页事件数 ≤ pageSize**（分页不被绕过）、检索结果也分页、内存增量有界（默认 ≤ 64 MiB）、
 *    且 2,000 与 20,000 条时**单页耗时增长不超过 10 倍**（提示是否存在线性退化，不假装通过）。
 *
 * 边界：不测 UI 渲染耗时、不测真实磁盘冷缓存；数字是本进程口径，标注清楚。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RunHistoryStore } from "../packages/core/src/orchestration/run-history-store.js";
import { buildRunHistoryTimelinePage } from "../packages/core/src/orchestration/run-history-view.js";

const SMALL_EVENT_COUNT = 2_000;
const LARGE_EVENT_COUNT = 20_000;
const PAGE_SIZE = 100;
const MAXIMUM_HEAP_DELTA_BYTES = 64 * 1024 * 1024;
const MAXIMUM_SLOWDOWN_RATIO = 10;

async function seedHistory(baseDirectory, missionIdentifier, eventCount) {
  const store = new RunHistoryStore({ baseDirectory });
  for (let index = 0; index < eventCount; index += 1) {
    await store.appendEvent({
      missionIdentifier,
      event: {
        eventIdentifier: `event-${String(index)}`,
        kind: index % 10 === 0 ? "tool-failure" : "tool-call",
        recordedAtIso: new Date(Date.UTC(2026, 9, 20, 0, 0, 0) + index * 1000).toISOString(),
        payloadJson: JSON.stringify({
          toolName: "projectFileRead",
          ...(index % 10 === 0
            ? { failureReason: "permission-denied" }
            : { outputText: `读取文件 #${String(index)} 的第 ${String(index % 7)} 段内容` }),
        }),
      },
    });
  }
  const readOutcome = await store.read(missionIdentifier);
  if (readOutcome.kind !== "valid") {
    throw new Error(`种子历史不可读：${readOutcome.kind}`);
  }
  return readOutcome.document;
}

function measureOnce(label, operation) {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const page = operation();
  const durationMilliseconds = performance.now() - startedAt;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  return {
    label,
    eventCountInPage: page.entries.length,
    durationMilliseconds: Number(durationMilliseconds.toFixed(3)),
    heapDeltaBytes,
    totalEventCount: page.totalEventCount ?? null,
    nextCursor: page.nextCursor ?? null,
    isPageBounded: page.entries.length <= PAGE_SIZE,
  };
}

async function measureAt(eventCount) {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-history-measure-"));
  try {
    const missionIdentifier = `mission-${String(eventCount)}`;
    const document = await seedHistory(baseDirectory, missionIdentifier, eventCount);
    const firstPage = measureOnce("first-page", () =>
      buildRunHistoryTimelinePage({ document, pageSize: PAGE_SIZE }),
    );
    const anchorSequenceNumber = Math.floor(eventCount / 2);
    const anchorPage = measureOnce("anchor-page", () =>
      buildRunHistoryTimelinePage({
        document,
        pageSize: 1,
        cursor: anchorSequenceNumber - 1,
      }),
    );
    const searchPage = measureOnce("search-page", () =>
      buildRunHistoryTimelinePage({ document, pageSize: PAGE_SIZE, searchQuery: "permission-denied" }),
    );
    return { eventCount, pages: [firstPage, anchorPage, searchPage] };
  } finally {
    await rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const small = await measureAt(SMALL_EVENT_COUNT);
const large = await measureAt(LARGE_EVENT_COUNT);

const failures = [];
for (const measurement of [small, large]) {
  for (const page of measurement.pages) {
    if (!page.isPageBounded) {
      failures.push(`${String(measurement.eventCount)} 条：${page.label} 返回 ${String(page.eventCountInPage)} 条，超过 pageSize`);
    }
    if (page.heapDeltaBytes > MAXIMUM_HEAP_DELTA_BYTES) {
      failures.push(
        `${String(measurement.eventCount)} 条：${page.label} 内存增量 ${String(page.heapDeltaBytes)} 字节，超过上限`,
      );
    }
  }
}

const smallFirstPageDuration = small.pages[0].durationMilliseconds;
const largeFirstPageDuration = large.pages[0].durationMilliseconds;
const slowdownRatio = smallFirstPageDuration === 0 ? Infinity : largeFirstPageDuration / smallFirstPageDuration;
if (slowdownRatio > MAXIMUM_SLOWDOWN_RATIO) {
  failures.push(
    `单页耗时从 ${String(smallFirstPageDuration)}ms 涨到 ${String(largeFirstPageDuration)}ms（${String(slowdownRatio.toFixed(1))}×），超过 ${String(MAXIMUM_SLOWDOWN_RATIO)}× 上限`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      pageSize: PAGE_SIZE,
      maximumHeapDeltaBytes: MAXIMUM_HEAP_DELTA_BYTES,
      maximumSlowdownRatio: MAXIMUM_SLOWDOWN_RATIO,
      measurements: [small, large],
      slowdownRatio: Number.isFinite(slowdownRatio) ? Number(slowdownRatio.toFixed(2)) : null,
      measurementBasis: "process.heapUsed-delta + performance.now（本进程口径，不含 UI 渲染与冷缓存）",
      failures,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  process.stderr.write(`HISTORY 资源测量失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("HISTORY 资源测量通过：分页有界、内存增量有界、无明显线性退化\n");
