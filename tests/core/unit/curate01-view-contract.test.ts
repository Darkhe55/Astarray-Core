/**
 * CURATE-01-03 只读视图的反例（2026-10-20 R105）。
 *
 * 核心：无来源不展示、跨个体不合并、推断必须标注、冲突保留、撤销不删内容、旧/新方案状态明确。
 */
import { describe, expect, it } from "vitest";

import {
  buildCurationViewSnapshot,
  type CurationDerivedItemV1,
} from "../../../packages/core/src/orchestration/curation-view-contract.js";

function item(overrides: Partial<CurationDerivedItemV1> = {}): CurationDerivedItemV1 {
  return {
    itemIdentifier: "item-1",
    ownerAgentInstanceIdentifier: "agent-1",
    planRevision: 3,
    isModelInference: false,
    unresolvedKind: null,
    sourceMessageIdentifiers: ["message-1"],
    sourceToolReceiptIdentifiers: [],
    ...overrides,
  };
}

const viewerOf = (...agents: string[]) =>
  new Set(agents.length === 0 ? ["agent-1"] : agents);

describe("CURATE-01-03 只读视图", () => {
  it("① 方案状态明确：active 可执行，撤销/待授权/被取代均不可执行", () => {
    const snapshot = buildCurationViewSnapshot({
      plans: [
        { planRevision: 3, isRevoked: false, isPendingApproval: false, isSuperseded: false },
        { planRevision: 4, isRevoked: false, isPendingApproval: true, isSuperseded: false },
        { planRevision: 2, isRevoked: false, isPendingApproval: false, isSuperseded: true },
        { planRevision: 1, isRevoked: true, isPendingApproval: false, isSuperseded: false },
      ],
      items: [],
      viewerAuthorizedAgentInstanceIdentifiers: viewerOf(),
    });
    expect(snapshot.plans.map((plan) => [plan.planRevision, plan.status, plan.isExecutable])).toEqual([
      [3, "active", true],
      [4, "pending-approval", false],
      [2, "superseded", false],
      [1, "revoked", false],
    ]);
  });

  it("② 无来源条目**不展示**但如实计数（可追溯是硬要求）", () => {
    const snapshot = buildCurationViewSnapshot({
      plans: [{ planRevision: 3, isRevoked: false, isPendingApproval: false, isSuperseded: false }],
      items: [
        item({ itemIdentifier: "with-message" }),
        item({
          itemIdentifier: "with-receipt",
          sourceMessageIdentifiers: [],
          sourceToolReceiptIdentifiers: ["receipt-1"],
        }),
        item({
          itemIdentifier: "no-source",
          sourceMessageIdentifiers: [],
          sourceToolReceiptIdentifiers: [],
        }),
      ],
      viewerAuthorizedAgentInstanceIdentifiers: viewerOf(),
    });
    expect(snapshot.visibleItems.map((visible) => visible.itemIdentifier)).toEqual([
      "with-message",
      "with-receipt",
    ]);
    expect(snapshot.unsourcedItemCount).toBe(1);
    // 视图永不删除原文
    expect(snapshot.isOriginalHistoryDeleted).toBe(false);
  });

  it("③ 跨个体不合并：无权查看的条目被过滤并计数", () => {
    const snapshot = buildCurationViewSnapshot({
      plans: [{ planRevision: 3, isRevoked: false, isPendingApproval: false, isSuperseded: false }],
      items: [
        item({ itemIdentifier: "mine", ownerAgentInstanceIdentifier: "agent-1" }),
        item({ itemIdentifier: "other", ownerAgentInstanceIdentifier: "agent-2" }),
      ],
      viewerAuthorizedAgentInstanceIdentifiers: viewerOf("agent-1"),
    });
    expect(snapshot.visibleItems).toHaveLength(1);
    expect(snapshot.visibleItems[0]?.itemIdentifier).toBe("mine");
    expect(snapshot.filteredByAuthorizationCount).toBe(1);
  });

  it("④ 模型推断必须保留标注（不得升格为事实）", () => {
    const snapshot = buildCurationViewSnapshot({
      plans: [{ planRevision: 3, isRevoked: false, isPendingApproval: false, isSuperseded: false }],
      items: [
        item({ itemIdentifier: "inferred", isModelInference: true }),
        item({ itemIdentifier: "fact", isModelInference: false }),
      ],
      viewerAuthorizedAgentInstanceIdentifiers: viewerOf(),
    });
    const byIdentifier = new Map(snapshot.visibleItems.map((visible) => [visible.itemIdentifier, visible]));
    expect(byIdentifier.get("inferred")?.isModelInference).toBe(true);
    expect(byIdentifier.get("fact")?.isModelInference).toBe(false);
  });

  it("⑤ 冲突/否定/未决/未知保留并计数（视图不自行结案）", () => {
    const snapshot = buildCurationViewSnapshot({
      plans: [{ planRevision: 3, isRevoked: false, isPendingApproval: false, isSuperseded: false }],
      items: [
        item({ itemIdentifier: "conflict", unresolvedKind: "conflict" }),
        item({ itemIdentifier: "negation", unresolvedKind: "negation" }),
        item({ itemIdentifier: "pending", unresolvedKind: "pending" }),
        item({ itemIdentifier: "unknown", unresolvedKind: "unknown" }),
        item({ itemIdentifier: "settled" }),
      ],
      viewerAuthorizedAgentInstanceIdentifiers: viewerOf(),
    });
    expect(snapshot.retainedUnresolvedCount).toBe(4);
    expect(snapshot.visibleItems.filter((visible) => visible.unresolvedKind !== null)).toHaveLength(4);
  });

  it("⑥ 撤销后已生成内容仍可查（撤销不自动删除）", () => {
    const snapshot = buildCurationViewSnapshot({
      plans: [{ planRevision: 3, isRevoked: true, isPendingApproval: false, isSuperseded: false }],
      items: [item({ itemIdentifier: "from-revoked-plan" })],
      viewerAuthorizedAgentInstanceIdentifiers: viewerOf(),
    });
    expect(snapshot.isRevokedContentRetained).toBe(true);
    // 默认不按"仅 active"过滤 ⇒ 历史方案的结果仍可见
    expect(snapshot.visibleItems).toHaveLength(1);
  });

  it("⑦ 可选「仅 active 方案条目」：旧方案结果可被隐藏（但原文仍在）", () => {
    const snapshot = buildCurationViewSnapshot({
      plans: [
        { planRevision: 3, isRevoked: false, isPendingApproval: false, isSuperseded: false },
        { planRevision: 2, isRevoked: false, isPendingApproval: false, isSuperseded: true },
      ],
      items: [
        item({ itemIdentifier: "current", planRevision: 3 }),
        item({ itemIdentifier: "old", planRevision: 2 }),
      ],
      viewerAuthorizedAgentInstanceIdentifiers: viewerOf(),
      isOnlyActivePlanItems: true,
    });
    expect(snapshot.visibleItems.map((visible) => visible.itemIdentifier)).toEqual(["current"]);
    expect(snapshot.isOriginalHistoryDeleted).toBe(false);
  });
});

