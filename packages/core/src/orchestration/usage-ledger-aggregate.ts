/**
 * USAGE-01-02（2026-10-19 R74）：账目聚合。
 *
 * 卡内依据：§USAGE "聚合与导出**分页**、**预算与估价**、**来源与修订在报表中保留**"；
 * §2 "数据来源区分本地测量、Provider 返回、估算、缺失和不支持；**unknown 不记作零**"。
 *
 * 聚合纪律：
 * 1. **可结算与估算分开报**：`billableTotalTokens`（provider 且 isBillable）与
 *    `estimatedTotalTokens`（local-estimate）**不许相加成一个"总用量"**；
 * 2. **缺失单独计数**：`missingEntryCount` + 分母 `entryCount`，缺失条目**不进**任何 token 合计；
 * 3. **来源保留**：`bySourceKind` 逐项给出条数与 token 合计；
 * 4. **修订保留**：同一请求出现多个修订时，`supersededRevisionCount` 如实计数（不覆盖历史）。
 *
 * ## 边界
 * 纯判定：不读库、不查账单、不做价格换算。
 */
import type { UsageLedgerEntryV1, UsageSourceKind } from "./usage-ledger-contract.js";

/** 单一来源的汇总。 */
export interface UsageSourceSummary {
  readonly entryCount: number;
  /** 缺失来源没有 token 数 ⇒ 恒为 null（不是 0）。 */
  readonly totalTokens: number | null;
}

/** 聚合结果。 */
export interface UsageLedgerAggregate {
  readonly entryCount: number;
  readonly missingEntryCount: number;
  readonly billableEntryCount: number;
  /** 仅来自 provider 且 isBillable 的 token 合计（可对账单）。 */
  readonly billableTotalTokens: number;
  /** 仅来自 local-estimate 的 token 合计（估算，不可结算）。 */
  readonly estimatedTotalTokens: number;
  /** 同一请求存在多个修订的次数（历史不被覆盖）。 */
  readonly supersededRevisionCount: number;
  readonly bySourceKind: Readonly<Record<UsageSourceKind, UsageSourceSummary>>;
}

/** 聚合账目。 */
export function aggregateUsageLedger(input: {
  readonly entries: ReadonlyArray<UsageLedgerEntryV1>;
}): UsageLedgerAggregate {
  const sourceTotals: Record<UsageSourceKind, { entryCount: number; totalTokens: number | null }> = {
    provider: { entryCount: 0, totalTokens: null },
    "local-estimate": { entryCount: 0, totalTokens: null },
    missing: { entryCount: 0, totalTokens: null },
  };
  const revisionsByRequest = new Map<string, Set<number>>();

  let missingEntryCount = 0;
  let billableEntryCount = 0;
  let billableTotalTokens = 0;
  let estimatedTotalTokens = 0;

  for (const entry of input.entries) {
    const bucket = sourceTotals[entry.sourceKind];
    bucket.entryCount += 1;

    if (entry.sourceKind === "missing" || entry.totalTokens === null) {
      missingEntryCount += 1;
    } else {
      bucket.totalTokens = (bucket.totalTokens ?? 0) + entry.totalTokens;
      if (entry.sourceKind === "provider" && entry.isBillable) {
        billableEntryCount += 1;
        billableTotalTokens += entry.totalTokens;
      }
      if (entry.sourceKind === "local-estimate") {
        estimatedTotalTokens += entry.totalTokens;
      }
    }

    const revisions = revisionsByRequest.get(entry.requestIdentifier) ?? new Set<number>();
    revisions.add(entry.requestRevision);
    revisionsByRequest.set(entry.requestIdentifier, revisions);
  }

  let supersededRevisionCount = 0;
  for (const revisions of revisionsByRequest.values()) {
    if (revisions.size > 1) supersededRevisionCount += revisions.size - 1;
  }

  return {
    entryCount: input.entries.length,
    missingEntryCount,
    billableEntryCount,
    billableTotalTokens,
    estimatedTotalTokens,
    supersededRevisionCount,
    bySourceKind: {
      provider: { ...sourceTotals.provider },
      "local-estimate": { ...sourceTotals["local-estimate"] },
      missing: { ...sourceTotals.missing },
    },
  };
}
