/**
 * DIAG-01-02 反例（2026-10-22）：持久汇总的**分页**、**可见范围过滤**与**证据包窗口**。
 *
 * 卡内：持久汇总、分页、只读规则诊断及证据包；重复风暴、故障链、不足证据、诊断自身失败反例。
 * 本文件专补"分页与覆盖"这一块（敏感文本/风暴/坏行已在包级验收覆盖）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DiagnosticEventStore,
  buildRedactedDiagnosticBundle,
  queryDiagnosticSummary,
  type DiagnosticEvent,
} from "../../../packages/core/src/orchestration/diagnostic-event-store.js";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<DiagnosticEventStore> {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-diag02-"));
  temporaryDirectories.push(baseDirectory);
  return new DiagnosticEventStore({ baseDirectory });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function event(overrides: Partial<DiagnosticEvent> & { index?: number } = {}): DiagnosticEvent {
  const index = overrides.index ?? 0;
  return {
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: new Date(Date.UTC(2026, 9, 22, 10, 0, 0) + index * 1_000).toISOString(),
    sourceAgentInstanceId: "agent-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    requestIdentifier: `request-${String(index)}`,
    requestRevision: 1,
    origin: { kind: "provider" },
    errorCode: overrides.errorCode ?? "provider-request-failed",
    stage: "provider",
    severity: "error",
    component: "provider-runtime",
    messageText: "请求失败",
    recoveryState: "recovering",
    classification: "deterministic-fact",
    chain: { rootErrorCode: "provider-request-failed", wrapperErrorCodes: [] },
    ...overrides,
  };
}

/** 造 5 个不同指纹，各若干条（共 15 条）。 */
async function seedDistinctGroups(store: DiagnosticEventStore): Promise<void> {
  let index = 0;
  for (let groupIndex = 0; groupIndex < 5; groupIndex += 1) {
    for (let repeat = 0; repeat < 3; repeat += 1) {
      await store.append(
        event({
          index,
          errorCode: `error-${String(groupIndex)}`,
          component: `component-${String(groupIndex)}`,
        }),
      );
      index += 1;
    }
  }
}

describe("DIAG-01-02 分页与覆盖", () => {
  it("① pageSize 生效：页内分组数 ≤ pageSize", async () => {
    const store = await createStore();
    await seedDistinctGroups(store);
    const summary = await queryDiagnosticSummary({ store, query: { pageSize: 2 } });
    expect(summary.page).not.toBeNull();
    expect(summary.page!.groups.length).toBeLessThanOrEqual(2);
    expect(summary.page!.groups.length).toBe(2);
  });

  it("② 游标翻页：无重复、无遗漏，并集=全部分组", async () => {
    const store = await createStore();
    await seedDistinctGroups(store);
    const full = await queryDiagnosticSummary({ store });
    const fingerprints = full.deterministicFindings.map((finding) => finding.fingerprint).sort();

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await queryDiagnosticSummary({
        store,
        query: cursor === null ? { pageSize: 2 } : { pageSize: 2, cursor },
      });
      if (page.page === null) break;
      seen.push(...page.page.groups.map((group) => group.fingerprint));
      cursor = page.page.nextCursor;
      if (cursor === null) break;
    }

    expect(new Set(seen).size).toBe(seen.length); // 无重复
    expect(seen.sort()).toEqual(fingerprints); // 无遗漏
  });

  it("③ mission 过滤：matched 只算该 mission，total 仍报全量", async () => {
    const store = await createStore();
    await store.append(event({ index: 1, missionIdentifier: "mission-1" }));
    await store.append(event({ index: 2, missionIdentifier: "mission-2" }));
    const summary = await queryDiagnosticSummary({ store, query: { missionIdentifier: "mission-2" } });
    expect(summary.coverage.totalEventCount).toBe(2);
    expect(summary.coverage.matchedEventCount).toBe(1);
    expect(summary.coverage.missionIdentifier).toBe("mission-2");
  });

  it("④ 个体过滤：不同 sourceAgentInstanceId 不互相可见", async () => {
    const store = await createStore();
    await store.append(event({ index: 1, sourceAgentInstanceId: "agent-1" }));
    await store.append(event({ index: 2, sourceAgentInstanceId: "agent-2" }));
    const summary = await queryDiagnosticSummary({ store, query: { sourceAgentInstanceId: "agent-1" } });
    expect(summary.coverage.matchedEventCount).toBe(1);
    expect(
      summary.deterministicFindings.every((finding) =>
        finding.evidence.sourceAgentInstanceIds.every((identifier) => identifier === "agent-1"),
      ),
    ).toBe(true);
    expect(
      summary.deterministicFindings.reduce((total, finding) => total + finding.occurrenceCount, 0),
    ).toBe(1);
  });

  it("⑤ 时间窗：窗外事件不计入 matched（证据包同窗口）", async () => {
    const store = await createStore();
    await store.append(event({ index: 1 }));
    await store.append(event({ index: 100 }));
    const summary = await queryDiagnosticSummary({
      store,
      query: { windowStartIso: "2026-10-22T10:00:00.000Z", windowEndIso: "2026-10-22T10:00:05.000Z" },
    });
    expect(summary.coverage.matchedEventCount).toBe(1);
    const bundle = await buildRedactedDiagnosticBundle({
      store,
      environment: { platform: "win32", astarrayVersion: "0.1.0" },
      windowStartIso: "2026-10-22T10:00:00.000Z",
      windowEndIso: "2026-10-22T10:00:05.000Z",
    });
    expect(bundle.summary.matchedEventCount).toBe(1);
  });

  it("⑥ 空库 ⇒ 不可报告（不报「一切正常」）", async () => {
    const store = await createStore();
    const summary = await queryDiagnosticSummary({ store });
    expect(summary.isReportable).toBe(false);
    expect(summary.unreportableReason ?? "").not.toBe("");
  });

  it("⑦ 推断与确定事实分列（isInference 标记正确）", async () => {
    const store = await createStore();
    await store.append(event({ index: 1, classification: "deterministic-fact", errorCode: "known" }));
    await store.append(event({ index: 2, classification: "suspected-cause", errorCode: "suspected" }));
    await store.append(event({ index: 3, classification: "insufficient-evidence", errorCode: "insufficient" }));
    const summary = await queryDiagnosticSummary({ store });
    expect(summary.deterministicFindings.every((finding) => finding.isInference === false)).toBe(true);
    expect(summary.suspectedFindings.every((finding) => finding.isInference === true)).toBe(true);
    expect(summary.insufficientEvidenceFindings.length).toBe(1);
    expect(summary.deterministicFindings.some((finding) => finding.errorCode === "suspected")).toBe(false);
  });

  it("⑧ 证据包**不含**完整会话/源码/原始日志，并带脱敏说明", async () => {
    const store = await createStore();
    await store.append(event({ index: 1 }));
    const bundle = await buildRedactedDiagnosticBundle({
      store,
      environment: { platform: "win32", astarrayVersion: "0.1.0" },
    });
    expect(bundle.containsFullSession).toBe(false);
    expect(bundle.containsSourceCode).toBe(false);
    expect(bundle.containsRawLogs).toBe(false);
    expect(bundle.redactionNotice).not.toBe("");
  });

  it("⑨ 坏行计入 coverage.discardedLineCount（诊断自身失败不静默）", async () => {
    const store = await createStore();
    await store.append(event({ index: 1 }));
    const { writeFile } = await import("node:fs/promises");
    // 坏行追加到实际落盘文件
    const baseDirectory = (store as unknown as { filePath: string }).filePath;
    await writeFile(baseDirectory, `${JSON.stringify({ broken: true })}\n`, { flag: "a" });
    const summary = await queryDiagnosticSummary({ store });
    expect(summary.coverage.discardedLineCount).toBeGreaterThanOrEqual(1);
  });
});

