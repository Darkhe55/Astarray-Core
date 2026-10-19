/**
 * USAGE 账目聚合的反例（2026-10-19 R74）。
 *
 * 核心：**可结算与估算分开报**、**缺失不进合计**、**修订不覆盖历史**。
 */
import { describe, expect, it } from "vitest";

import { aggregateUsageLedger } from "../../../packages/core/src/orchestration/usage-ledger-aggregate.js";
import type { UsageLedgerEntryV1 } from "../../../packages/core/src/orchestration/usage-ledger-contract.js";

function entry(overrides: Partial<UsageLedgerEntryV1> = {}): UsageLedgerEntryV1 {
  return {
    schemaVersion: 1,
    requestIdentifier: "request-1",
    requestRevision: 1,
    sourceKind: "provider",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    isBillable: true,
    missingReason: null,
    ...overrides,
  };
}

describe("USAGE 账目聚合", () => {
  it("① 可结算与估算**分开**合计（不相加成总用量）", () => {
    const aggregate = aggregateUsageLedger({
      entries: [
        entry({ requestIdentifier: "r1", totalTokens: 100 }),
        entry({ requestIdentifier: "r2", sourceKind: "local-estimate", isBillable: false, totalTokens: 40 }),
      ],
    });
    expect(aggregate.billableTotalTokens).toBe(100);
    expect(aggregate.estimatedTotalTokens).toBe(40);
  });

  it("② 缺失条目**不进** token 合计，只计数", () => {
    const aggregate = aggregateUsageLedger({
      entries: [
        entry({ requestIdentifier: "r1", totalTokens: 50 }),
        entry({
          requestIdentifier: "r2",
          sourceKind: "missing",
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          isBillable: false,
          missingReason: "provider 未返回 usage",
        }),
      ],
    });
    expect(aggregate.entryCount).toBe(2);
    expect(aggregate.missingEntryCount).toBe(1);
    expect(aggregate.billableTotalTokens).toBe(50);
    // 缺失来源没有 token 数 ⇒ null，不是 0
    expect(aggregate.bySourceKind.missing.totalTokens).toBeNull();
    expect(aggregate.bySourceKind.missing.entryCount).toBe(1);
  });

  it("③ 估算即使被标成可结算也不算进可结算合计（防御性）", () => {
    const aggregate = aggregateUsageLedger({
      entries: [
        entry({ requestIdentifier: "r1", sourceKind: "local-estimate", isBillable: true, totalTokens: 999 }),
      ],
    });
    expect(aggregate.billableTotalTokens).toBe(0);
    expect(aggregate.billableEntryCount).toBe(0);
    expect(aggregate.estimatedTotalTokens).toBe(999);
  });

  it("④ 同一请求多个修订 ⇒ 如实计数（历史不被覆盖）", () => {
    const aggregate = aggregateUsageLedger({
      entries: [
        entry({ requestIdentifier: "r1", requestRevision: 1 }),
        entry({ requestIdentifier: "r1", requestRevision: 2 }),
        entry({ requestIdentifier: "r1", requestRevision: 3 }),
        entry({ requestIdentifier: "r2", requestRevision: 1 }),
      ],
    });
    expect(aggregate.supersededRevisionCount).toBe(2);
  });

  it("⑤ 逐来源条数与合计（provider / 估算 / 缺失）", () => {
    const aggregate = aggregateUsageLedger({
      entries: [
        entry({ requestIdentifier: "r1", totalTokens: 10 }),
        entry({ requestIdentifier: "r2", totalTokens: 20 }),
        entry({ requestIdentifier: "r3", sourceKind: "local-estimate", isBillable: false, totalTokens: 5 }),
      ],
    });
    expect(aggregate.bySourceKind.provider).toEqual({ entryCount: 2, totalTokens: 30 });
    expect(aggregate.bySourceKind["local-estimate"]).toEqual({ entryCount: 1, totalTokens: 5 });
    expect(aggregate.bySourceKind.missing).toEqual({ entryCount: 0, totalTokens: null });
  });

  it("⑥ 空账本 ⇒ 全零且缺失合计为 null（不报错、不虚报）", () => {
    const aggregate = aggregateUsageLedger({ entries: [] });
    expect(aggregate.entryCount).toBe(0);
    expect(aggregate.billableTotalTokens).toBe(0);
    expect(aggregate.bySourceKind.provider.totalTokens).toBeNull();
  });
});
