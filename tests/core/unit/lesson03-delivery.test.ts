/**
 * LESSON-01-03 投递账目反例（2026-10-20）。
 *
 * 覆盖卡内四条：三节点接线、关闭无自动总结/检索、模型切换不串用、崩溃重试无重复投递。
 */
import { describe, expect, it } from "vitest";

import {
  computeLessonDeliveryKey,
  computeLessonModelFingerprint,
  planLessonDelivery,
  reconcileLessonDeliveriesAfterModelSwitch,
  recordLessonDeliveryResult,
  type LessonDeliveryItem,
} from "../../../packages/core/src/orchestration/lesson-delivery.js";
import type { LessonModelSnapshot } from "../../../packages/core/src/orchestration/lesson-record-contract.js";

const modelA: LessonModelSnapshot = {
  providerIdentifier: "provider-a",
  modelIdentifier: "model-a",
  modelVersionIdentifier: "2026-10",
  effectiveConfiguration: { reasoning: "high" },
};

function item(overrides: Partial<LessonDeliveryItem> = {}): LessonDeliveryItem {
  return {
    recordIdentifier: "lesson-1",
    revision: 2,
    recipientAgentInstanceId: "agent-1",
    sourceTaskIdentifier: "task-1",
    modelSnapshot: modelA,
    ...overrides,
  };
}

describe("LESSON-01-03 投递账目", () => {
  it("① 三节点都能规划投递，且投递键含阶段（不同阶段不串）", () => {
    const stages = ["dispatch", "receive", "review"] as const;
    const keys = stages.map((stage) => {
      const plan = planLessonDelivery({
        stage,
        items: [item()],
        isAutoSummaryEnabled: true,
        isReviewPassed: true,
      });
      expect(plan.kind).toBe("deliver");
      if (plan.kind !== "deliver") throw new Error("unreachable");
      return plan.entries[0]?.deliveryKey;
    });
    expect(new Set(keys).size).toBe(3);
  });

  it("② 关闭自动总结 ⇒ 不投递（no-auto-summary），且不产生空记录", () => {
    const plan = planLessonDelivery({
      stage: "dispatch",
      items: [item()],
      isAutoSummaryEnabled: false,
    });
    expect(plan).toMatchObject({ kind: "rejected", reasonCode: "no-auto-summary", entries: [] });
    if (plan.kind !== "rejected") throw new Error("unreachable");
    expect(plan.reason).toContain("不会后台偷偷总结");
  });

  it("③ 审查未通过 ⇒ 审查节点拒绝（不能自证推广）", () => {
    const plan = planLessonDelivery({
      stage: "review",
      items: [item()],
      isAutoSummaryEnabled: true,
      isReviewPassed: false,
    });
    expect(plan).toMatchObject({ kind: "rejected", reasonCode: "review-required" });
  });

  it("④ 空选择 ⇒ empty-selection（不假装成功）", () => {
    const plan = planLessonDelivery({ stage: "dispatch", items: [], isAutoSummaryEnabled: true });
    expect(plan).toMatchObject({ kind: "rejected", reasonCode: "empty-selection" });
  });

  it("⑤ 崩溃重试：同投递键同结果 ⇒ duplicate-suppressed（不重复投递）", () => {
    const plan = planLessonDelivery({ stage: "dispatch", items: [item()], isAutoSummaryEnabled: true });
    if (plan.kind !== "deliver") throw new Error("unreachable");
    const entry = plan.entries[0];
    if (entry === undefined) throw new Error("unreachable");

    const first = recordLessonDeliveryResult({ ledger: [], entry, outcome: "delivered" });
    expect(first.kind).toBe("recorded");
    const retry = recordLessonDeliveryResult({
      ledger: first.ledger,
      entry,
      outcome: "delivered",
    });
    expect(retry.kind).toBe("duplicate-suppressed");
    expect(retry.ledger).toHaveLength(1);
  });

  it("⑥ 同投递键不同结果 ⇒ conflict（不覆盖账目）", () => {
    const plan = planLessonDelivery({ stage: "dispatch", items: [item()], isAutoSummaryEnabled: true });
    if (plan.kind !== "deliver") throw new Error("unreachable");
    const entry = plan.entries[0];
    if (entry === undefined) throw new Error("unreachable");

    const first = recordLessonDeliveryResult({ ledger: [], entry, outcome: "failed" });
    const conflict = recordLessonDeliveryResult({
      ledger: first.ledger,
      entry,
      outcome: "delivered",
    });
    expect(conflict.kind).toBe("conflict");
    expect(conflict.reason).toContain("需人工核对");
  });

  it("⑦ 投递键对「记录 revision」敏感：revision 变了就是新投递", () => {
    const first = computeLessonDeliveryKey({
      stage: "dispatch",
      recordIdentifier: "lesson-1",
      revision: 1,
      recipientAgentInstanceId: "agent-1",
      sourceTaskIdentifier: "task-1",
    });
    const second = computeLessonDeliveryKey({
      stage: "dispatch",
      recordIdentifier: "lesson-1",
      revision: 2,
      recipientAgentInstanceId: "agent-1",
      sourceTaskIdentifier: "task-1",
    });
    expect(first).not.toBe(second);
  });

  it("⑧ 模型切换 ⇒ 旧模型下的待投递条目全部作废（不串给新模型）", () => {
    const plan = planLessonDelivery({ stage: "dispatch", items: [item()], isAutoSummaryEnabled: true });
    if (plan.kind !== "deliver") throw new Error("unreachable");
    const reconciliation = reconcileLessonDeliveriesAfterModelSwitch({
      pendingEntries: plan.entries,
      currentModelSnapshot: { ...modelA, modelIdentifier: "model-b" },
    });
    expect(reconciliation.deliverable).toHaveLength(0);
    expect(reconciliation.invalidatedDeliveryKeys).toHaveLength(1);
    expect(reconciliation.reason).toContain("不把旧模型下的教训串给新模型");
  });

  it("⑨ 模型未变 ⇒ 仍可投递", () => {
    const plan = planLessonDelivery({ stage: "receive", items: [item()], isAutoSummaryEnabled: true });
    if (plan.kind !== "deliver") throw new Error("unreachable");
    const reconciliation = reconcileLessonDeliveriesAfterModelSwitch({
      pendingEntries: plan.entries,
      currentModelSnapshot: modelA,
    });
    expect(reconciliation.deliverable).toHaveLength(1);
    expect(reconciliation.invalidatedDeliveryKeys).toHaveLength(0);
  });

  it("⑩ 同模型不同生效配置 ⇒ 视为模型已变（指纹含配置）", () => {
    const plan = planLessonDelivery({ stage: "dispatch", items: [item()], isAutoSummaryEnabled: true });
    if (plan.kind !== "deliver") throw new Error("unreachable");
    const reconciliation = reconcileLessonDeliveriesAfterModelSwitch({
      pendingEntries: plan.entries,
      currentModelSnapshot: { ...modelA, effectiveConfiguration: { reasoning: "low" } },
    });
    expect(reconciliation.invalidatedDeliveryKeys).toHaveLength(1);
  });

  it("⑪ 模型指纹稳定性：同快照多次计算相同（账目可复算）", () => {
    expect(computeLessonModelFingerprint(modelA)).toBe(computeLessonModelFingerprint({ ...modelA }));
  });

  it("⑫ 审查节点通过 + 有条目 ⇒ 可投递（正例，避免「一律拒绝」的过度保守）", () => {
    const plan = planLessonDelivery({
      stage: "review",
      items: [item()],
      isAutoSummaryEnabled: true,
      isReviewPassed: true,
    });
    expect(plan.kind).toBe("deliver");
  });
});


