/**
 * 证据快照（此前 `tests/` 零引用）。
 *
 * 这是"发给远端的证据包"的构造与校验层，测试重点是三件事：
 * **确定性**（同输入同哈希）、**遗漏必须记账**（截断/脱敏/区间外都要计数），
 * 以及**完整性校验**能识别出任何字段被改动。
 */
import { describe, expect, it } from "vitest";

import {
  EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
  MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS,
  buildEvidenceSnapshot,
  verifyEvidenceSnapshotIntegrity,
} from "../../../packages/core/src/orchestration/remote-evidence-snapshot.js";
import type {
  EvidenceSnapshotCandidateEntry,
  EvidenceSnapshotRequest,
} from "../../../packages/core/src/orchestration/remote-evidence-snapshot.js";

const CAPTURED_AT = "2026-11-13T12:00:00.000Z";

function buildRequest(overrides: Partial<EvidenceSnapshotRequest> = {}): EvidenceSnapshotRequest {
  return {
    requestIdentifier: "request-1",
    projectIdentifier: "project-alpha",
    conversationIdentifier: "conversation-1",
    missionIdentifiers: ["mission-2", "mission-1"],
    ...overrides,
  };
}

function buildCandidate(
  overrides: Partial<EvidenceSnapshotCandidateEntry> = {},
): EvidenceSnapshotCandidateEntry {
  return {
    entryIdentifier: "entry-1",
    sourceKind: "tool-result",
    sourceAgentInstanceIdentifier: "agent-1",
    recordedAtIso: "2026-11-13T10:00:00.000Z",
    recordReference: "record-1",
    excerptText: "工具输出",
    ...overrides,
  };
}

function buildSnapshot(overrides: {
  request?: Partial<EvidenceSnapshotRequest>;
  candidates?: readonly EvidenceSnapshotCandidateEntry[];
  additionalReasonCodes?: readonly string[];
} = {}) {
  return buildEvidenceSnapshot({
    request: buildRequest(overrides.request),
    candidateEntries: overrides.candidates ?? [buildCandidate()],
    snapshotRevision: 1,
    capturedAtIso: CAPTURED_AT,
    ...(overrides.additionalReasonCodes === undefined
      ? {}
      : { additionalReasonCodes: overrides.additionalReasonCodes }),
  });
}

describe("快照构造的前提", () => {
  it("① 缺 requestIdentifier / projectIdentifier / 无 mission ⇒ 拒绝构造", () => {
    expect(() => buildSnapshot({ request: { requestIdentifier: " " } })).toThrow(/requestIdentifier/u);
    expect(() => buildSnapshot({ request: { projectIdentifier: "" } })).toThrow(/projectIdentifier/u);
    expect(() => buildSnapshot({ request: { missionIdentifiers: [] } })).toThrow(/至少需要一个 mission/u);
  });

  it("② 确定性：同输入两次得到相同哈希与相同顺序（乱序输入也稳定）", () => {
    const candidates = [
      buildCandidate({ entryIdentifier: "entry-b", recordedAtIso: "2026-11-13T11:00:00.000Z" }),
      buildCandidate({ entryIdentifier: "entry-a", recordedAtIso: "2026-11-13T10:00:00.000Z" }),
    ];
    const first = buildSnapshot({ candidates });
    const second = buildSnapshot({ candidates: [candidates[1]!, candidates[0]!] });

    expect(first.contentHash).toBe(second.contentHash);
    expect(first.entries.map((entry) => entry.entryIdentifier)).toEqual(["entry-a", "entry-b"]);
    expect(first.schemaVersion).toBe(EVIDENCE_SNAPSHOT_SCHEMA_VERSION);
    expect(first.isRealtime).toBe(false);
  });
});

describe("遗漏必须记账", () => {
  it("③ 超长摘录 ⇒ 截断并计数，理由码记录", () => {
    const longText = "x".repeat(MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS + 50);
    const snapshot = buildSnapshot({ candidates: [buildCandidate({ excerptText: longText })] });

    expect(snapshot.entries[0]?.isTruncated).toBe(true);
    expect(snapshot.entries[0]?.excerptText.length).toBe(MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS);
    expect(snapshot.omissions.truncatedEntryCount).toBe(1);
    expect(snapshot.omissions.reasonCodes).toContain("excerpt-truncated");
  });

  it("④ 脱敏条目 ⇒ 计数并记录理由码", () => {
    const snapshot = buildSnapshot({
      candidates: [buildCandidate({ isRedacted: true })],
    });
    expect(snapshot.entries[0]?.isRedacted).toBe(true);
    expect(snapshot.omissions.redactedEntryCount).toBe(1);
    expect(snapshot.omissions.reasonCodes).toContain("content-redacted");
  });

  it("⑤ 区间外条目被排除并计数；区间非法 ⇒ 拒绝构造", () => {
    const snapshot = buildSnapshot({
      request: { fromIso: "2026-11-13T09:00:00.000Z", toIso: "2026-11-13T11:00:00.000Z" },
      candidates: [
        buildCandidate({ entryIdentifier: "inside", recordedAtIso: "2026-11-13T10:00:00.000Z" }),
        buildCandidate({ entryIdentifier: "outside", recordedAtIso: "2026-11-13T11:30:00.000Z" }),
      ],
    });
    expect(snapshot.entries.map((entry) => entry.entryIdentifier)).toEqual(["inside"]);
    expect(snapshot.omissions.omittedEntryCount).toBe(1);
    expect(snapshot.omissions.reasonCodes).toContain("time-range-outside");

    expect(() => buildSnapshot({ request: { fromIso: "not-a-date" } })).toThrow(/fromIso 非法/u);
    expect(() =>
      buildSnapshot({
        request: { fromIso: "2026-11-13T12:00:00.000Z", toIso: "2026-11-13T10:00:00.000Z" },
      }),
    ).toThrow(/时间区间非法/u);
  });

  it("⑥ lastObservedAtIso 取数据中最晚时间（不是抓取时间）；无条目时回退", () => {
    const withEntries = buildSnapshot({
      candidates: [buildCandidate({ recordedAtIso: "2026-11-13T11:59:00.000Z" })],
    });
    expect(withEntries.lastObservedAtIso).toBe("2026-11-13T11:59:00.000Z");

    const empty = buildSnapshot({
      candidates: [],
    });
    expect(empty.entries).toEqual([]);
    expect(empty.lastObservedAtIso).toBe(CAPTURED_AT);
  });

  it("⑦ 来源集合去重排序；mission 标识排序；额外理由码去重合并", () => {
    const snapshot = buildSnapshot({
      candidates: [
        buildCandidate({ entryIdentifier: "e1", sourceKind: "tool-result" }),
        buildCandidate({
          entryIdentifier: "e2",
          sourceKind: "user-message",
          sourceAgentInstanceIdentifier: null,
        }),
        buildCandidate({ entryIdentifier: "e3", sourceKind: "tool-result" }),
      ],
      additionalReasonCodes: ["excerpt-truncated", "some-source-missing"],
    });
    expect(snapshot.sourceKinds).toEqual(["tool-result", "user-message"]);
    expect(snapshot.sourceAgentInstanceIdentifiers).toEqual(["agent-1"]);
    expect(snapshot.missionIdentifiers).toEqual(["mission-1", "mission-2"]);
    /** 额外理由码去重，且不重复既有码。 */
    expect(snapshot.omissions.reasonCodes.filter((code) => code === "excerpt-truncated")).toHaveLength(1);
    expect(snapshot.omissions.reasonCodes).toContain("some-source-missing");
  });

  it("⑧ 摘要派生条目必须自带覆盖条目数；非摘要条目恒为 null", () => {
    const snapshot = buildSnapshot({
      candidates: [
        buildCandidate({ entryIdentifier: "summary", isSummaryDerived: true, summaryCoveredEntryCount: 7 }),
        buildCandidate({ entryIdentifier: "raw", isSummaryDerived: false }),
      ],
    });
    const summary = snapshot.entries.find((entry) => entry.entryIdentifier === "summary");
    const raw = snapshot.entries.find((entry) => entry.entryIdentifier === "raw");
    expect(summary?.isSummaryDerived).toBe(true);
    expect(summary?.summaryCoveredEntryCount).toBe(7);
    expect(raw?.isSummaryDerived).toBe(false);
    expect(raw?.summaryCoveredEntryCount).toBeNull();
  });
});

describe("完整性校验", () => {
  it("⑨ 原快照校验通过；任何字段被改动即失败", () => {
    const snapshot = buildSnapshot();
    expect(verifyEvidenceSnapshotIntegrity(snapshot)).toBe(true);

    const tamperedText = {
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({ ...entry, excerptText: "被改过的内容" })),
    };
    expect(verifyEvidenceSnapshotIntegrity(tamperedText)).toBe(false);

    expect(
      verifyEvidenceSnapshotIntegrity({ ...snapshot, snapshotRevision: snapshot.snapshotRevision + 1 }),
    ).toBe(false);
    expect(
      verifyEvidenceSnapshotIntegrity({
        ...snapshot,
        omissions: { ...snapshot.omissions, omittedEntryCount: 99 },
      }),
    ).toBe(false);
  });

  it("⑩ 哈希不含自身：同一内容重新构造仍通过校验", () => {
    const snapshot = buildSnapshot();
    const rebuilt = buildSnapshot();
    expect(rebuilt.contentHash).toBe(snapshot.contentHash);
    expect(verifyEvidenceSnapshotIntegrity(rebuilt)).toBe(true);
  });
});
