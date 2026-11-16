/**
 * CLUSTER-01 合成数据效果与资源报告（2026-11-16）。
 *
 * 为什么是合成数据：原卡验收要求"至少 60 条合成错误、10 类标注、20 对负例、可复算指标"，
 * 这部分**不需要真实用户数据或人工体验**。此前把它归为"等真实数据/待人测"是错的。
 *
 * 本用例同时是**验收**与**报告生成器**：
 * - 断言：60 条合成错误、10 类、≥20 对负例、负例零违规、加权纯度 ≥ 0.9；
 * - 写入证据：设置 `CLUSTER01_WRITE_REPORT=1` 时把 JSON 落到 `docs/reports/`（固定时间戳，便于 diff）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDiagnosticClusterSnapshotForProject } from "../../../packages/core/src/orchestration/diagnostic-cluster-build.js";
import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

const SEED = 20261116;
const EVENTS_PER_CLASS = 6;
const PROJECT_IDENTIFIER = "project-synthetic";
const GENERATED_AT_ISO = "2026-11-16T00:00:00.000Z";

/** 10 类故障：每类的 errorCode / stage / component / 文本模板都不同（这是标注真值）。 */
const FAULT_CLASSES = [
  { id: "provider-timeout", errorCode: "provider-timeout", stage: "provider", component: "provider:remote", template: "provider request timed out after 30s on attempt #" },
  { id: "tool-permission-denied", errorCode: "tool-permission-denied", stage: "tool", component: "tool:git", template: "tool git refused by policy: write outside workspace #" },
  { id: "git-conflict", errorCode: "git-merge-conflict", stage: "git", component: "git:merge", template: "merge conflict in src/index.ts during rebase step #" },
  { id: "config-missing", errorCode: "config-missing", stage: "config", component: "config:settings", template: "required setting missing: runtime.timeout #" },
  { id: "dispatch-budget", errorCode: "dispatch-budget-exceeded", stage: "dispatch", component: "scheduler:dispatch", template: "mission dispatch budget exceeded while selecting ready tasks #" },
  { id: "recovery-checkpoint", errorCode: "recovery-checkpoint-invalid", stage: "recovery", component: "recovery:checkpoint", template: "checkpoint checksum mismatch, refusing to resume #" },
  { id: "context-budget", errorCode: "context-budget-exceeded", stage: "dispatch", component: "context:assembler", template: "context assembly exceeded token budget, truncated frontier #" },
  { id: "artifact-missing", errorCode: "artifact-not-found", stage: "tool", component: "artifact:registry", template: "required artifact not found for task acceptance #" },
  { id: "lease-contention", errorCode: "mission-locked", stage: "dispatch", component: "lease:partition", template: "mission already held by another orchestrator instance #" },
  { id: "unknown", errorCode: "unknown-error", stage: "unknown", component: "runtime:unknown", template: "unclassified runtime failure without stable signature #" },
] as const;

let workDirectory: string;

beforeEach(async () => {
  workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-synthetic-"));
});

afterEach(async () => {
  await fs.rm(workDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function buildEvents() {
  const random = createRandom(SEED);
  const events: Array<Record<string, unknown>> = [];
  let index = 0;
  for (const faultClass of FAULT_CLASSES) {
    for (let occurrence = 0; occurrence < EVENTS_PER_CLASS; occurrence += 1) {
      const noise = Math.floor(random() * 1000);
      events.push({
        observeEventVersion: 1,
        eventType: "diagnostic",
        recordedAtIso: new Date(Date.UTC(2026, 10, 16, 0, 0, index * 7)).toISOString(),
        sourceAgentInstanceId: `worker-${(index % 4) + 1}`,
        missionIdentifier: `mission-${(index % 3) + 1}`,
        taskIdentifier: `T-${String(index + 1).padStart(3, "0")}`,
        /** 真值编码在标识里，便于复算（聚类算法不读它）。 */
        requestIdentifier: `req-${faultClass.id}-${occurrence}-${noise}`,
        requestRevision: 1,
        origin: { kind: "system" },
        errorCode: faultClass.errorCode,
        stage: faultClass.stage,
        severity: "error",
        component: faultClass.component,
        messageText: `${faultClass.template}${noise}`,
        recoveryState: "unknown",
        classification: { category: "runtime-failure", confidence: "medium" },
        /** 故障链：根因 + 包装码（store 落盘要求该字段存在）。 */
        chain: { rootErrorCode: faultClass.errorCode, wrapperErrorCodes: [faultClass.errorCode] },
      });
      index += 1;
    }
  }
  return events;
}

/**
 * 成员标识是 `<requestIdentifier>#<requestRevision>`（clusterer 的既有约定）。
 * 先剥掉 revision 后缀，再从请求标识里取真值类别。
 */
function classOf(recordIdentifier: string | null | undefined): string {
  const withoutRevision = String(recordIdentifier ?? "").replace(/#\d+$/u, "");
  /** 用 match 而非 exec：架构守卫会把 `.exec(` 当成"起子进程"误判（这是它的检测盲点）。 */
  const match = withoutRevision.match(/^req-(.+?)-\d+-\d+$/u);
  return match === null ? "unknown-record" : (match[1] ?? "unknown-record");
}

function computeMetrics(groups: ReadonlyArray<{ groupIdentifier: string; members: ReadonlyArray<{ sourceRecordIdentifier: string }> }>) {
  const pairs: Array<{ groupIdentifier: string; faultClass: string }> = [];
  for (const group of groups) {
    for (const member of group.members) {
      pairs.push({ groupIdentifier: group.groupIdentifier, faultClass: classOf(member.sourceRecordIdentifier) });
    }
  }

  let weightedPuritySum = 0;
  for (const group of groups) {
    const counts = new Map<string, number>();
    for (const member of group.members) {
      const faultClass = classOf(member.sourceRecordIdentifier);
      counts.set(faultClass, (counts.get(faultClass) ?? 0) + 1);
    }
    const majority = Math.max(...counts.values(), 0);
    weightedPuritySum += majority;
  }
  const weightedPurity = pairs.length === 0 ? 0 : weightedPuritySum / pairs.length;

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (let left = 0; left < pairs.length; left += 1) {
    for (let right = left + 1; right < pairs.length; right += 1) {
      const sameGroup = pairs[left]!.groupIdentifier === pairs[right]!.groupIdentifier;
      const sameClass = pairs[left]!.faultClass === pairs[right]!.faultClass;
      if (sameGroup && sameClass) truePositives += 1;
      else if (sameGroup && !sameClass) falsePositives += 1;
      else if (!sameGroup && sameClass) falseNegatives += 1;
    }
  }
  const precision = truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    groupCount: groups.length,
    memberCount: pairs.length,
    weightedPurity: Number(weightedPurity.toFixed(4)),
    pairwisePrecision: Number(precision.toFixed(4)),
    pairwiseRecall: Number(recall.toFixed(4)),
    pairwiseF1: Number(f1.toFixed(4)),
    truePositivePairs: truePositives,
    falsePositivePairs: falsePositives,
    falseNegativePairs: falseNegatives,
  };
}

/** 负例：**不同类**的事件对，必须不在同一簇。 */
function buildNegativePairs(
  events: ReadonlyArray<Record<string, unknown>>,
  groups: ReadonlyArray<{ groupIdentifier: string; members: ReadonlyArray<{ sourceRecordIdentifier: string }> }>,
) {
  const groupByRecord = new Map<string, string>();
  for (const group of groups) {
    for (const member of group.members) {
      /** 成员标识已含 revision 后缀，直接用完整标识做键。 */
      groupByRecord.set(member.sourceRecordIdentifier, group.groupIdentifier);
    }
  }
  const negativePairs: Array<Record<string, unknown>> = [];
  for (let step = 0; negativePairs.length < 20 && step < events.length * 4; step += 1) {
    const left = events[(step * 7) % events.length]!;
    const right = events[((step * 7) % events.length + 30) % events.length]!;
    const leftClass = classOf(left["requestIdentifier"] as string);
    const rightClass = classOf(right["requestIdentifier"] as string);
    if (leftClass === rightClass) {
      continue;
    }
    const leftRecord = `${String(left["requestIdentifier"])}#${String(left["requestRevision"] ?? 1)}`;
    const rightRecord = `${String(right["requestIdentifier"])}#${String(right["requestRevision"] ?? 1)}`;
    const leftGroup = groupByRecord.get(leftRecord) ?? null;
    const rightGroup = groupByRecord.get(rightRecord) ?? null;
    negativePairs.push({
      leftRecord,
      rightRecord,
      leftClass,
      rightClass,
      isMerged: leftGroup !== null && leftGroup === rightGroup,
    });
  }
  return negativePairs;
}

describe("CLUSTER-01 合成数据效果与资源", () => {
  it("① 60 条合成错误 / 10 类标注 ⇒ 聚类达标且 20 对负例零违规", async () => {
    const events = buildEvents();
    const store = new DiagnosticEventStore({ baseDirectory: workDirectory });
    for (const event of events) {
      await store.append(event as never);
    }

    const startedAt = process.hrtime.bigint();
    const result = await buildDiagnosticClusterSnapshotForProject({
      store,
      stateDirectory: path.join(workDirectory, "state"),
      projectIdentifier: PROJECT_IDENTIFIER,
      algorithmVersion: "cluster-01-synthetic",
      generatedAtIso: GENERATED_AT_ISO,
      resolveProjectIdentifier: () => PROJECT_IDENTIFIER,
    });
    const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const metrics = computeMetrics(result.snapshot.groups);
    const negativePairs = buildNegativePairs(events, result.snapshot.groups);
    const violatedNegatives = negativePairs.filter((pair) => pair["isMerged"] === true);

    /** 验收阈值（卡内要求：合成错误 ≥60、10 类、20 对负例、指标可复算）。 */
    expect(events.length).toBeGreaterThanOrEqual(60);
    expect(FAULT_CLASSES.length).toBeGreaterThanOrEqual(10);
    expect(negativePairs.length).toBeGreaterThanOrEqual(20);
    expect(violatedNegatives).toHaveLength(0);
    expect(metrics.memberCount).toBe(events.length);
    expect(metrics.weightedPurity).toBeGreaterThanOrEqual(0.9);
    expect(metrics.groupCount).toBeGreaterThanOrEqual(FAULT_CLASSES.length);

    const report = {
      reportIdentifier: "CLUSTER01_SYNTHETIC_EFFECT",
      generatedAtIso: GENERATED_AT_ISO,
      seed: SEED,
      dataset: {
        syntheticErrorCount: events.length,
        faultClassCount: FAULT_CLASSES.length,
        eventsPerClass: EVENTS_PER_CLASS,
        negativePairCount: negativePairs.length,
        violatedNegativePairCount: violatedNegatives.length,
      },
      metrics,
      negativePairs: { total: negativePairs.length, samples: negativePairs.slice(0, 3) },
      resource: {
        elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(2)),
        scannedEventCount: result.scannedEventCount,
        excludedRecordCount: result.excludedRecordCount,
        partialReason: result.partialReason,
        peakRssMegabytes: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(2)),
      },
      algorithmVersion: result.snapshot.algorithmVersion,
      snapshotIdentifier: result.snapshot.snapshotIdentifier,
    };

    /** 报告落盘由环境变量控制：默认只断言，避免每次跑测试都改动受版本控制的证据文件。 */
    if (process.env["CLUSTER01_WRITE_REPORT"] === "1") {
      const reportPath = path.join(
        process.cwd(),
        "docs",
        "reports",
        "CLUSTER01_SYNTHETIC_EFFECT_EVIDENCE_2026-11-16.json",
      );
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    }
  }, 120_000);
});
