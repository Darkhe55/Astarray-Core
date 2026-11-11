/**
 * CLUSTER-01 §3 第 7 条：相似案例检索的行为锁定。
 *
 * 反例重点：跨桶不得返回、低于阈值的不得返回、上限必须夹紧、
 * 并且结果必须显式声明"相似度不是根因置信度"。
 */
import { describe, expect, it } from "vitest";

import {
  buildDiagnosticBucketKey,
  clusterDiagnosticEvents,
  type DiagnosticClusterInput,
} from "../../../packages/core/src/orchestration/diagnostic-clusterer.js";
import {
  buildDiagnosticClusterSnapshot,
  type DiagnosticClusterSnapshot,
} from "../../../packages/core/src/orchestration/diagnostic-cluster-index.js";
import { findRelatedDiagnosticCases } from "../../../packages/core/src/orchestration/diagnostic-related-cases.js";

function buildInput(
  overrides: Partial<DiagnosticClusterInput> & { messageText: string; sourceRecordIdentifier: string },
): DiagnosticClusterInput {
  return {
    recordedAtIso: "2026-11-11T00:00:00.000Z",
    errorCode: "E_TIMEOUT",
    component: "worker",
    stage: "execute",
    classification: "transient",
    projectIdentifier: "project-alpha",
    chain: { rootErrorCode: "E_TIMEOUT", wrapperErrorCodes: [] },
    ...overrides,
  };
}

function buildSnapshot(events: readonly DiagnosticClusterInput[]): DiagnosticClusterSnapshot {
  return buildDiagnosticClusterSnapshot({
    algorithmVersion: "diagnostic-cluster-v1",
    projectIdentifier: "project-alpha",
    generatedAtIso: "2026-11-11T00:00:00.000Z",
    cursor: { byteOffset: 0, lineNumber: 0 },
    isComplete: true,
    groups: clusterDiagnosticEvents(events).groups,
    configuration: { similarityThreshold: 0.85 },
  });
}

describe("CLUSTER-01 相似案例检索", () => {
  it("只返回同桶且达到阈值的案例，并带相似度分数", () => {
    const target = buildInput({ sourceRecordIdentifier: "r1", messageText: "连接超时 timeout 重试" });
    const similar = buildInput({ sourceRecordIdentifier: "r2", messageText: "连接超时 timeout 重试" });
    const otherBucket = buildInput({
      sourceRecordIdentifier: "r3",
      messageText: "连接超时 timeout 重试",
      errorCode: "E_OTHER",
      chain: { rootErrorCode: "E_OTHER", wrapperErrorCodes: [] },
    });
    const snapshot = buildSnapshot([target, similar, otherBucket]);
    const result = findRelatedDiagnosticCases({ event: target, snapshot });

    expect(result.cases.length).toBeGreaterThan(0);
    expect(result.cases.every((related) => related.similarityScore >= 0.85)).toBe(true);
    /** 跨桶不得出现（那条组的桶键与查询不同）。 */
    expect(result.cases.every((related) => related.groupIdentifier.startsWith(buildDiagnosticBucketKey(target)))).toBe(true);
    /** 显式声明不是根因置信度。 */
    expect(result.isRootCauseConfidence).toBe(false);
  });

  it("低于最低相似度 ⇒ 空结果（不得凑数）", () => {
    const target = buildInput({ sourceRecordIdentifier: "r1", messageText: "完全不同的第一段文本内容" });
    const unrelated = buildInput({ sourceRecordIdentifier: "r2", messageText: "另一段毫无重叠的描述文本" });
    const snapshot = buildSnapshot([unrelated]);
    const result = findRelatedDiagnosticCases({ event: target, snapshot, minimumSimilarity: 0.85 });
    expect(result.cases).toEqual([]);
  });

  it("limit 默认 5，超过 20 被夹紧到 20", () => {
    const events = Array.from({ length: 25 }, (_unused, index) =>
      buildInput({ sourceRecordIdentifier: `r${String(index)}`, messageText: "相同文本 连接超时" }),
    );
    const snapshot = buildSnapshot(events);
    const query = buildInput({ sourceRecordIdentifier: "query", messageText: "相同文本 连接超时" });

    const defaultLimit = findRelatedDiagnosticCases({ event: query, snapshot });
    expect(defaultLimit.limit).toBe(5);
    expect(defaultLimit.cases.length).toBeLessThanOrEqual(5);

    const clampedLimit = findRelatedDiagnosticCases({ event: query, snapshot, limit: 999 });
    expect(clampedLimit.limit).toBe(20);
    expect(clampedLimit.cases.length).toBeLessThanOrEqual(20);
  });

  it("结果确定性：分数降序，同分按组 ID 字典序", () => {
    const events = [
      buildInput({ sourceRecordIdentifier: "r1", messageText: "超时 连接 timeout" }),
      buildInput({ sourceRecordIdentifier: "r2", messageText: "超时 连接 timeout" }),
      buildInput({ sourceRecordIdentifier: "r3", messageText: "超时 连接 timeout" }),
    ];
    const snapshot = buildSnapshot(events);
    const query = buildInput({ sourceRecordIdentifier: "query", messageText: "超时 连接 timeout" });
    const first = findRelatedDiagnosticCases({ event: query, snapshot, limit: 20 });
    const second = findRelatedDiagnosticCases({ event: query, snapshot, limit: 20 });
    expect(first.cases.map((item) => item.groupIdentifier)).toEqual(
      second.cases.map((item) => item.groupIdentifier),
    );
    for (let index = 1; index < first.cases.length; index += 1) {
      const previous = first.cases[index - 1]!;
      const current = first.cases[index]!;
      expect(previous.similarityScore).toBeGreaterThanOrEqual(current.similarityScore);
    }
  });
});
