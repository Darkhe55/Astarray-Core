/**
 * LESSON-01-03（2026-10-20）：**投递账目与接线契约**（分派 / 接收 / 审查三个节点）。
 *
 * 卡内判据（L 行 LESSON-01-03）："分派/接收/审查节点的应用接线、**恢复**、产品设置及包消费验证；
 * 场景 A/B/C 从公开入口走通；**关闭无自动总结/检索**；**模型切换不串用**；**崩溃重试无重复推广/投递**"。
 *
 * 本模块先交付**接线所需的端口与账目**（不改调度器）：
 * 1. 投递键**确定性**（阶段 + 教训记录 revision + 接收个体 + 源任务）⇒ 崩溃重试天然幂等；
 * 2. **关闭开关 ⇒ 不投递、不自动总结/检索**（`no-auto-summary` 明确拒绝，不静默）；
 * 3. **模型切换不串用**：投递时绑定模型快照指纹；恢复时若模型已变，则**作废**而不是投给新模型；
 * 4. **审查节点**单独可拒绝（推广需审查通过，不能自证）。
 */
import { createHash } from "node:crypto";

import type { LessonModelSnapshot } from "./lesson-record-contract.js";

/** 三个接线节点。 */
export type LessonDeliveryStage = "dispatch" | "receive" | "review";

/** 待投递条目。 */
export interface LessonDeliveryItem {
  readonly recordIdentifier: string;
  readonly revision: number;
  readonly recipientAgentInstanceId: string;
  readonly sourceTaskIdentifier: string;
  readonly modelSnapshot: LessonModelSnapshot;
}

/** 投递计划条目。 */
export interface LessonDeliveryPlanEntry {
  /** 确定性投递键（崩溃重试靠它幂等）。 */
  readonly deliveryKey: string;
  readonly stage: LessonDeliveryStage;
  readonly recordIdentifier: string;
  readonly revision: number;
  readonly recipientAgentInstanceId: string;
  /** 绑定的模型快照指纹：模型变了就不许投给新模型。 */
  readonly modelFingerprint: string;
}

/** 投递计划。 */
export type LessonDeliveryPlan =
  | {
      readonly kind: "deliver";
      readonly entries: ReadonlyArray<LessonDeliveryPlanEntry>;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode: "no-auto-summary" | "empty-selection" | "review-required";
      readonly reason: string;
      readonly entries: ReadonlyArray<LessonDeliveryPlanEntry>;
    };

/** 账目条目（调用方持久化）。 */
export interface LessonDeliveryLedgerEntry {
  readonly deliveryKey: string;
  readonly outcome: "delivered" | "failed" | "review-rejected";
}

/** 模型指纹：provider+model+版本+实际生效配置。 */
export function computeLessonModelFingerprint(snapshot: LessonModelSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        snapshot.providerIdentifier,
        snapshot.modelIdentifier,
        snapshot.modelVersionIdentifier,
        snapshot.effectiveConfiguration,
      ]),
    )
    .digest("hex");
}

/** 确定性投递键。 */
export function computeLessonDeliveryKey(input: {
  readonly stage: LessonDeliveryStage;
  readonly recordIdentifier: string;
  readonly revision: number;
  readonly recipientAgentInstanceId: string;
  readonly sourceTaskIdentifier: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.stage,
        input.recordIdentifier,
        input.revision,
        input.recipientAgentInstanceId,
        input.sourceTaskIdentifier,
      ]),
    )
    .digest("hex");
}

/**
 * 规划投递。
 *
 * 纪律：
 * - `isAutoSummaryEnabled === false` ⇒ 直接 `no-auto-summary`（**不自动总结/检索**）；
 * - 审查节点需要 `isReviewPassed === true`，否则 `review-required`（不能自证推广）；
 * - 空选择 ⇒ `empty-selection`（不"成功但什么都没发"）。
 */
export function planLessonDelivery(input: {
  readonly stage: LessonDeliveryStage;
  readonly items: ReadonlyArray<LessonDeliveryItem>;
  readonly isAutoSummaryEnabled: boolean;
  readonly isReviewPassed?: boolean;
}): LessonDeliveryPlan {
  const entries = input.items.map((item) => ({
    deliveryKey: computeLessonDeliveryKey({
      stage: input.stage,
      recordIdentifier: item.recordIdentifier,
      revision: item.revision,
      recipientAgentInstanceId: item.recipientAgentInstanceId,
      sourceTaskIdentifier: item.sourceTaskIdentifier,
    }),
    stage: input.stage,
    recordIdentifier: item.recordIdentifier,
    revision: item.revision,
    recipientAgentInstanceId: item.recipientAgentInstanceId,
    modelFingerprint: computeLessonModelFingerprint(item.modelSnapshot),
  }));

  if (!input.isAutoSummaryEnabled) {
    return {
      kind: "rejected",
      reasonCode: "no-auto-summary",
      reason: "自动总结/检索已关闭：不投递任何教训（也不会后台偷偷总结）。",
      entries: [],
    };
  }
  if (input.stage === "review" && input.isReviewPassed !== true) {
    return {
      kind: "rejected",
      reasonCode: "review-required",
      reason: "推广需审查通过：审查节点未通过前不投递（不能自证）。",
      entries: [],
    };
  }
  if (entries.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "empty-selection",
      reason: "没有可投递的教训：不产生空投递记录冒充成功。",
      entries: [],
    };
  }
  return { kind: "deliver", entries };
}

/** 提交投递结果（幂等；崩溃重试不重复投递）。 */
export function recordLessonDeliveryResult(input: {
  readonly ledger: ReadonlyArray<LessonDeliveryLedgerEntry>;
  readonly entry: LessonDeliveryPlanEntry;
  readonly outcome: LessonDeliveryLedgerEntry["outcome"];
}): {
  readonly kind: "recorded" | "duplicate-suppressed" | "conflict";
  readonly ledger: ReadonlyArray<LessonDeliveryLedgerEntry>;
  readonly reason: string;
} {
  const existing = input.ledger.find((entry) => entry.deliveryKey === input.entry.deliveryKey);
  if (existing === undefined) {
    return {
      kind: "recorded",
      ledger: [...input.ledger, { deliveryKey: input.entry.deliveryKey, outcome: input.outcome }],
      reason: "已记录投递结果。",
    };
  }
  if (existing.outcome === input.outcome) {
    return {
      kind: "duplicate-suppressed",
      ledger: input.ledger,
      reason: "同一投递键与结果已记录：不重复投递（崩溃重试安全）。",
    };
  }
  return {
    kind: "conflict",
    ledger: input.ledger,
    reason:
      "同一投递键出现不同结果（已记录 " +
      existing.outcome +
      "，本次 " +
      input.outcome +
      "）：拒绝覆盖，需人工核对。",
  };
}

/**
 * 模型切换后的恢复：**已绑定的投递不得发给新模型**。
 *
 * 返回 `invalidated` 的键，调用方据此作废并（可选）在旧模型下重投。
 */
export function reconcileLessonDeliveriesAfterModelSwitch(input: {
  readonly pendingEntries: ReadonlyArray<LessonDeliveryPlanEntry>;
  readonly currentModelSnapshot: LessonModelSnapshot;
}): {
  readonly deliverable: ReadonlyArray<LessonDeliveryPlanEntry>;
  readonly invalidatedDeliveryKeys: ReadonlyArray<string>;
  readonly reason: string;
} {
  const currentFingerprint = computeLessonModelFingerprint(input.currentModelSnapshot);
  const deliverable = input.pendingEntries.filter(
    (entry) => entry.modelFingerprint === currentFingerprint,
  );
  const invalidatedDeliveryKeys = input.pendingEntries
    .filter((entry) => entry.modelFingerprint !== currentFingerprint)
    .map((entry) => entry.deliveryKey);

  return {
    deliverable,
    invalidatedDeliveryKeys,
    reason:
      invalidatedDeliveryKeys.length === 0
        ? "模型未变：待投递条目仍可投递。"
        : "模型已切换：" +
          String(invalidatedDeliveryKeys.length) +
          " 条投递作废（不把旧模型下的教训串给新模型）。",
  };
}
