/**
 * USAGE-01-01 的反例（2026-10-19 R67）。
 *
 * 关键纪律：**unknown 不记作零**、**估算不得声明可结算**、**同键异参拒绝**、总量与子量自洽。
 */
import { describe, expect, it } from "vitest";

import {
  buildUsageLedgerEntry,
  evaluateUsageLedgerAppend,
  type UsageLedgerEntryV1,
} from "../../../packages/core/src/orchestration/usage-ledger-contract.js";

function acceptedEntry(overrides: Record<string, unknown> = {}): UsageLedgerEntryV1 {
  const decision = buildUsageLedgerEntry({
    requestIdentifier: "request-1",
    requestRevision: 1,
    sourceKind: "provider",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    isBillable: true,
    ...overrides,
  });
  if (decision.kind !== "accepted") throw new Error(`期望 accepted，实际 ${decision.kind}`);
  return decision.entry;
}

describe("USAGE-01-01：请求级账目契约", () => {
  it("① Provider 来源 + 三项计数 ⇒ 接受且可结算", () => {
    const entry = acceptedEntry();
    expect(entry.sourceKind).toBe("provider");
    expect(entry.totalTokens).toBe(30);
    expect(entry.isBillable).toBe(true);
  });

  it("② 来源缺失 ⇒ 计数必须为 null 且给出原因（unknown 不记作零）", () => {
    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "request-1",
        requestRevision: 1,
        sourceKind: "missing",
        missingReason: "provider 未返回 usage",
      }),
    ).toMatchObject({ kind: "accepted" });

    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "request-1",
        requestRevision: 1,
        sourceKind: "missing",
        totalTokens: 0,
        missingReason: "provider 未返回 usage",
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "unknown-not-zeroed" });

    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "request-1",
        requestRevision: 1,
        sourceKind: "missing",
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "missing-reason-absent" });
  });

  it("③ 有来源但缺任一计数 ⇒ 拒绝（应改用 missing 来源说明）", () => {
    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "request-1",
        requestRevision: 1,
        sourceKind: "provider",
        inputTokens: 10,
        totalTokens: 30,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "unknown-not-zeroed" });
  });

  it("④ 子量之和不大于总量 ⇒ 通过；大于 ⇒ 拒绝（总量/子量不自洽）", () => {
    expect(acceptedEntry({ inputTokens: 10, outputTokens: 20, totalTokens: 30 })).toBeDefined();
    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "request-1",
        requestRevision: 1,
        sourceKind: "provider",
        inputTokens: 20,
        outputTokens: 20,
        totalTokens: 30,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "totals-inconsistent" });
  });

  it("⑤ 本地估算不得声明可结算", () => {
    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "request-1",
        requestRevision: 1,
        sourceKind: "local-estimate",
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        isBillable: true,
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "estimate-claimed-billable" });

    const estimateEntry = buildUsageLedgerEntry({
      requestIdentifier: "request-1",
      requestRevision: 1,
      sourceKind: "local-estimate",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    if (estimateEntry.kind !== "accepted") throw new Error("应接受");
    expect(estimateEntry.entry.isBillable).toBe(false);
  });

  it("⑥ 同键同内容 ⇒ 幂等；同键异参 ⇒ 拒绝", () => {
    const first = acceptedEntry();
    expect(
      evaluateUsageLedgerAppend({ candidate: acceptedEntry(), existingEntries: [first] }).kind,
    ).toBe("idempotent-replay");
    expect(
      evaluateUsageLedgerAppend({
        candidate: acceptedEntry({ totalTokens: 31, outputTokens: 20, inputTokens: 11 }),
        existingEntries: [first],
      }),
    ).toMatchObject({ kind: "rejected", reasonCode: "same-key-different-parameters" });
  });

  it("⑦ 缺请求标识 / 修订非法 ⇒ 拒绝", () => {
    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "  ",
        requestRevision: 1,
        sourceKind: "provider",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    ).toMatchObject({ reasonCode: "missing-request-identifier" });
    expect(
      buildUsageLedgerEntry({
        requestIdentifier: "request-1",
        requestRevision: 0,
        sourceKind: "provider",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    ).toMatchObject({ reasonCode: "invalid-revision" });
  });
});
