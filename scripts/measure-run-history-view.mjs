#!/usr/bin/env node
/**
 * HISTORY-01-04 的**资源测量**（卡内 §5/§7.5：分页、内存上界、首次可读延迟、检索耗时，
 * 且"附规模及设备，不预填指标通过"）。
 *
 * ## 为什么父进程写夹具、子进程只测量
 *
 * 若在同一进程里先造 5 万条事件的数组、再读同一份文档，`heapUsed` 的差值里混着
 * **未回收的夹具垃圾**，得到的"内存占用"会把测量工具本身算进去。
 * 因此：父进程只负责**落盘**夹具，**每个规模各起一个子进程**，子进程只做读操作 ——
 * 内存差值才是读路径的代价。
 *
 * ## 只测读路径
 *
 * `RunHistoryStore.appendEvent()` 每次都重写整份文档（写入 O(n²)），那是已知设计边界，
 * 由报告 §4 单独记录，**不混进**这里的读测量。
 *
 * 用法：
 *   node scripts/measure-run-history-view.mjs                  # 1k/10k/50k
 *   node scripts/measure-run-history-view.mjs --events 1000,5000
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listRunHistoryMissions,
  queryRunHistoryTimeline,
} from "../dist/public-sdk.js";

const eventsArgumentIndex = process.argv.indexOf("--events");
const isChildMode = process.argv[2] === "--child";

function millisecondsSince(startedAtNanoseconds) {
  return Number(process.hrtime.bigint() - startedAtNanoseconds) / 1_000_000;
}

async function measureLatency(operation, repetitions) {
  const samples = [];
  for (let attempt = 0; attempt < repetitions; attempt += 1) {
    const startedAt = process.hrtime.bigint();
    await operation();
    samples.push(millisecondsSince(startedAt));
  }
  samples.sort((left, right) => left - right);
  const middle = Math.floor(samples.length / 2);
  return {
    medianMilliseconds: Number(samples[middle].toFixed(1)),
    minimumMilliseconds: Number(samples[0].toFixed(1)),
    maximumMilliseconds: Number(samples[samples.length - 1].toFixed(1)),
    samples: samples.length,
  };
}

/** 生成一份文档并**直接落盘**（不经 appendEvent，避免把 O(n²) 写路径算进读测量）。 */
function writeDocument(baseDirectory, missionIdentifier, eventCount, outputTextLength) {
  const events = [];
  for (let index = 1; index <= eventCount; index += 1) {
    const isFailure = index % 17 === 0;
    events.push({
      eventIdentifier: `${isFailure ? "tool-failure" : "tool-call"}:readFile:${String(index)}`,
      kind: isFailure ? "tool-failure" : "tool-call",
      recordedAtIso: "2026-10-18T00:00:00.000Z",
      payloadJson: JSON.stringify(
        isFailure
          ? { toolName: "readFile", failureReason: "permission-denied-" + String(index) }
          : { toolName: "readFile", outputText: `payload-${String(index)}-` + "x".repeat(outputTextLength) },
      ),
    });
  }
  const document = {
    schemaVersion: 1,
    missionIdentifier,
    segments: [
      { segmentRevision: 1, startedAtIso: "2026-10-18T00:00:00.000Z", events },
    ],
  };
  const filePath = path.join(baseDirectory, "run-history", `${missionIdentifier}.json`);
  writeFileSync(filePath, JSON.stringify(document), "utf8");
  return filePath;
}

// ── 子进程模式：只测量读路径 ────────────────────────────────────────────────
if (isChildMode) {
  const baseDirectory = process.argv[3];
  const missionIdentifier = process.argv[4];
  const eventCount = Number(process.argv[5]);
  const fileSizeBytes = Number(process.argv[6]);

  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;

  const firstPage = await measureLatency(async () => {
    const outcome = await queryRunHistoryTimeline({ baseDirectory, missionIdentifier, pageSize: 20 });
    if (outcome.kind !== "valid") throw new Error("测量数据应可读");
  }, 5);

  const tailPage = await measureLatency(async () => {
    const outcome = await queryRunHistoryTimeline({
      baseDirectory,
      missionIdentifier,
      pageSize: 20,
      cursor: Math.max(0, eventCount - 100),
    });
    if (outcome.kind !== "valid") throw new Error("测量数据应可读");
  }, 5);

  const search = await measureLatency(async () => {
    const outcome = await queryRunHistoryTimeline({
      baseDirectory,
      missionIdentifier,
      pageSize: 20,
      searchQuery: "permission-denied-" + String(eventCount),
    });
    if (outcome.kind !== "valid") throw new Error("测量数据应可读");
  }, 3);

  const searchOutcome = await queryRunHistoryTimeline({
    baseDirectory,
    missionIdentifier,
    pageSize: 20,
    searchQuery: "permission-denied",
  });

  console.log(
    JSON.stringify({
      eventCount,
      fileSizeBytes,
      firstPage,
      tailPage,
      search,
      searchMatchCount: searchOutcome.kind === "valid" ? searchOutcome.page.searchMatchCount : null,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      rssDeltaBytes: process.memoryUsage().rss - rssBefore,
    }),
  );
  process.exit(0);
}

// ── 父进程模式：写夹具 + 起子进程 + 列表分页测量 ────────────────────────────
const eventCounts =
  eventsArgumentIndex === -1
    ? [1_000, 10_000, 50_000]
    : process.argv[eventsArgumentIndex + 1].split(",").map((value) => Number(value));

const workspace = mkdtempSync(path.join(os.tmpdir(), "astarray-history-measure-"));
mkdirSync(path.join(workspace, "run-history"), { recursive: true });

try {
  const results = [];
  for (const eventCount of eventCounts) {
    const missionIdentifier = `mission-measure-${String(eventCount)}`;
    const filePath = writeDocument(workspace, missionIdentifier, eventCount, 200);
    const fileSizeBytes = statSync(filePath).size;

    const child = spawnSync(
      process.execPath,
      [
        process.argv[1],
        "--child",
        workspace,
        missionIdentifier,
        String(eventCount),
        String(fileSizeBytes),
      ],
      { encoding: "utf8" },
    );
    if (child.status !== 0) {
      console.error("子进程测量失败：" + (child.stderr ?? "").slice(0, 500));
      process.exit(1);
    }
    results.push(JSON.parse((child.stdout ?? "").trim()));
  }

  // 列表分页：200 个 mission，一页只应读 20 个文件（不随总数线性）
  for (let index = 0; index < 200; index += 1) {
    writeDocument(workspace, `mission-list-${String(index)}`, 3, 20);
  }
  const expectedMissionCount = 200 + eventCounts.length;
  let filesReadPerPage = 0;
  const listLatency = await measureLatency(async () => {
    let readCount = 0;
    const page = await listRunHistoryMissions({
      baseDirectory: workspace,
      pageSize: 20,
      onHistoryRead: () => {
        readCount += 1;
      },
    });
    filesReadPerPage = readCount;
    if (page.totalMissionCount !== expectedMissionCount) {
      throw new Error(`列表总数应为 ${String(expectedMissionCount)}`);
    }
  }, 3);

  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        nodeVersion: process.version,
        processor: os.cpus()[0]?.model ?? "unknown",
        totalMemoryBytes: os.totalmem(),
        results,
        list: { missionCount: expectedMissionCount, latency: listLatency, filesReadPerPage },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
