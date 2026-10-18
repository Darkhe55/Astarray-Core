/**
 * OBS PERF/DIAG 采集契约的反例（2026-10-19 R37）。
 *
 * 用户决策（按推荐）：默认 off、≤1 样本/5s、≤10MB 环形、进程内指标、只复用 DomainError+doctor、
 * 只存分类+指纹+脱敏摘要、不外传、CLI 可查、观测故障不阻塞业务。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS,
  DEFAULT_PERF_STORAGE_BUDGET_BYTES,
  buildPerfSample,
  computeDiagFingerprint,
  describeObservabilityBoundary,
  evaluateDiagEventAcceptance,
  evaluateObservabilityFailure,
  evaluatePerfCollection,
} from "../../../packages/core/src/orchestration/observability-collection-contract.js";

function collectionInput(overrides: Record<string, unknown> = {}) {
  return {
    isCollectionEnabled: true,
    lastSampleAtIso: null,
    nowIso: "2026-10-19T00:00:00.000Z",
    storageBytesUsed: 0,
    ...overrides,
  };
}

describe("OBS PERF/DIAG 采集契约", () => {
  it("① 默认关闭：未显式开启 ⇒ 不采样", () => {
    const decision = evaluatePerfCollection(collectionInput({ isCollectionEnabled: false }));
    expect(decision).toMatchObject({ kind: "skip", reasonCode: "collection-disabled" });
    expect(DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS).toBe(5);
    expect(DEFAULT_PERF_STORAGE_BUDGET_BYTES).toBe(10 * 1024 * 1024);
  });

  it("② 采样间隔：间隔未到 ⇒ 跳过；到点 ⇒ 采样", () => {
    expect(
      evaluatePerfCollection(
        collectionInput({ lastSampleAtIso: "2026-10-19T00:00:00.000Z", nowIso: "2026-10-19T00:00:02.000Z" }),
      ),
    ).toMatchObject({ kind: "skip", reasonCode: "interval-not-elapsed" });

    expect(
      evaluatePerfCollection(
        collectionInput({ lastSampleAtIso: "2026-10-19T00:00:00.000Z", nowIso: "2026-10-19T00:00:06.000Z" }),
      ).kind,
    ).toBe("sample");
  });

  it("③ 存储预算耗尽 ⇒ 停可选采集并报告（不静默删历史）", () => {
    const decision = evaluatePerfCollection(
      collectionInput({ storageBytesUsed: DEFAULT_PERF_STORAGE_BUDGET_BYTES }),
    );
    expect(decision).toMatchObject({ kind: "skip", reasonCode: "storage-budget-exhausted" });
    if (decision.kind !== "skip") throw new Error("应跳过");
    expect(decision.reason).toContain("不静默删除");
  });

  it("④ 采样字段白名单：OS 级/未知指标一律拒绝", () => {
    expect(
      buildPerfSample({
        sampledAtIso: "2026-10-19T00:00:00.000Z",
        processIdentifier: 1,
        agentInstanceIdentifier: null,
        fields: { cpuPercent: 12 },
      }).kind,
    ).toBe("rejected");

    const built = buildPerfSample({
      sampledAtIso: "2026-10-19T00:00:00.000Z",
      processIdentifier: 1,
      agentInstanceIdentifier: "agent-1",
      fields: { residentMemoryBytes: 1024, queueDepth: 0 },
      droppedSampleCount: 2,
    });
    expect(built.kind).toBe("built");
    if (built.kind !== "built") throw new Error("应生成");
    expect(built.sample.droppedSampleCount).toBe(2);
    expect(built.sample.fields.residentMemoryBytes).toBe(1024);
  });

  it("⑤ 非法数值（NaN/负数）⇒ 拒绝（unknown 不记作零）", () => {
    expect(
      buildPerfSample({
        sampledAtIso: "2026-10-19T00:00:00.000Z",
        processIdentifier: 1,
        agentInstanceIdentifier: null,
        fields: { eventLoopDelayMs: Number.NaN },
      }).kind,
    ).toBe("rejected");
    expect(
      buildPerfSample({
        sampledAtIso: "2026-10-19T00:00:00.000Z",
        processIdentifier: 1,
        agentInstanceIdentifier: null,
        fields: { taskDurationMs: -1 },
      }).kind,
    ).toBe("rejected");
  });

  it("⑥ DIAG 只接受 DomainError/doctor；网络/磁盘探测与含敏感内容一律拒绝", () => {
    const cleanSanitization = {
      containsRawArguments: false,
      containsHomeDirectoryPath: false,
      containsCredentialLikeValue: false,
    };
    expect(
      evaluateDiagEventAcceptance({
        sourceKind: "network-probe",
        classification: "timeout",
        sanitization: cleanSanitization,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "unsupported-probe" });

    for (const sourceKind of ["domain-error", "doctor"] as const) {
      expect(
        evaluateDiagEventAcceptance({
          sourceKind,
          classification: "permission-denied",
          sanitization: cleanSanitization,
        }).kind,
      ).toBe("accepted");
    }

    expect(
      evaluateDiagEventAcceptance({
        sourceKind: "domain-error",
        classification: "permission-denied",
        sanitization: { ...cleanSanitization, containsRawArguments: true },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "contains-raw-arguments" });
    expect(
      evaluateDiagEventAcceptance({
        sourceKind: "domain-error",
        classification: "permission-denied",
        sanitization: { ...cleanSanitization, containsHomeDirectoryPath: true },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "contains-home-directory-path" });
    expect(
      evaluateDiagEventAcceptance({
        sourceKind: "doctor",
        classification: "provider-error",
        sanitization: { ...cleanSanitization, containsCredentialLikeValue: true },
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "contains-credential-like-value" });
    expect(
      evaluateDiagEventAcceptance({
        sourceKind: "doctor",
        classification: "  ",
        sanitization: cleanSanitization,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "missing-classification" });
  });

  it("⑦ 指纹只依赖来源/分类/操作（同类问题聚合，不依赖原始文本）", () => {
    const first = computeDiagFingerprint({
      sourceKind: "domain-error",
      classification: "permission-denied",
      operationIdentifier: "writeFile",
    });
    const sameAgain = computeDiagFingerprint({
      sourceKind: "domain-error",
      classification: "permission-denied",
      operationIdentifier: "writeFile",
    });
    const differentOperation = computeDiagFingerprint({
      sourceKind: "domain-error",
      classification: "permission-denied",
      operationIdentifier: "readFile",
    });
    expect(first).toBe(sameAgain);
    expect(first).not.toBe(differentOperation);
  });

  it("⑧ 边界可核对：不上传、不存原始参数/文本、不采 OS 级、默认 off", () => {
    expect(describeObservabilityBoundary()).toEqual({
      isUploadEnabled: false,
      storesRawArguments: false,
      storesRawErrorText: false,
      collectsOsLevelMetrics: false,
      isLocalOnly: true,
      samplesDefaultOff: true,
    });
  });

  it("⑨ 观测故障不得阻塞业务（降级并报告）", () => {
    for (const failureKind of ["write-failed", "query-failed", "sampling-failed"] as const) {
      const decision = evaluateObservabilityFailure({ failureKind });
      expect(decision.blocksBusinessOperations).toBe(false);
      expect(decision.reportAsDegraded).toBe(true);
    }
  });
});
