/**
 * CURATE-01-02（EXP-01，2026-10-19 R23）：**周期增量执行、个体隔离、计划锁/预算/取消/恢复**。
 *
 * 卡内依据（`docs/tasks/EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS.md` §4）：
 * - 「**按具体 Agent 分别整理**；用户聚合视图只引用有权查看的条目，**不把同级记忆合并进模型上下文**」；
 * - 「使用 SUM 增量索引与源 revision，**未变化内容不反复总结**；**处理到已提交游标**，
 *   正在流入的新内容留给下一轮；**摘要失败不损坏原文或假装覆盖完整**」；
 * - 「调度复用工作时段/本地运行时，**只执行一个同方案实例**；**错过周期合并为一次待处理**，
 *   **不补跑所有遗漏次数**」；
 * - 「**应用关闭时不保证运行**，下次启动在授权仍有效时续处理」；「**休息时不触发模型整理**；
 *   **达到预算暂停并报告**」；「自动报告入档，**不因周期整理完成唤醒主 Agent**」。
 *
 * ## 边界
 * 纯判定：不调度、不调模型、不写盘、不删原文。
 */
import { createHash } from "node:crypto";

/** 一次整理运行的锁（同一方案只允许一个实例）。 */
export interface CurationRunLockV1 {
  readonly schemaVersion: 1;
  readonly planIdentifier: string;
  readonly runIdentifier: string;
  readonly acquiredAtIso: string;
}

/** 获取锁的结论。 */
export type CurationLockOutcome =
  | { readonly kind: "acquired"; readonly lock: CurationRunLockV1 }
  | {
      readonly kind: "already-running";
      readonly existingLock: CurationRunLockV1;
      readonly reason: string;
    };

/**
 * 获取"同方案单实例"锁。
 *
 * 重复触发 ⇒ `already-running`（**不并发、不重复整理**）；同一 runIdentifier 重放同样不重复获取。
 */
export function acquireCurationRunLock(input: {
  readonly planIdentifier: string;
  readonly runIdentifier: string;
  readonly acquiredAtIso: string;
  readonly existingLock: CurationRunLockV1 | null;
}): CurationLockOutcome {
  if (input.existingLock !== null) {
    return {
      kind: "already-running",
      existingLock: input.existingLock,
      reason:
        input.existingLock.runIdentifier === input.runIdentifier
          ? "同一运行已开始（幂等重放）。"
          : "该方案已有运行实例：不并发执行第二个。",
    };
  }
  return {
    kind: "acquired",
    lock: {
      schemaVersion: 1,
      planIdentifier: input.planIdentifier,
      runIdentifier: input.runIdentifier,
      acquiredAtIso: input.acquiredAtIso,
    },
  };
}

/**
 * 错过多个周期 ⇒ **合并为一次**待处理（不补跑历史触发）。
 */
export function planCurationPendingRun(input: {
  readonly lastHandledAtIso: string;
  readonly nowIso: string;
  readonly intervalMinutes: number;
}): { readonly isDue: boolean; readonly missedPeriodCount: number; readonly coalescedRunCount: number; readonly reason: string } {
  const last = Date.parse(input.lastHandledAtIso);
  const now = Date.parse(input.nowIso);
  if ([last, now].some((value) => Number.isNaN(value)) || !Number.isFinite(input.intervalMinutes) || input.intervalMinutes <= 0) {
    return {
      isDue: false,
      missedPeriodCount: 0,
      coalescedRunCount: 0,
      reason: "时间或周期参数无效：不做调度判定。",
    };
  }
  const elapsedMinutes = (now - last) / 60_000;
  if (elapsedMinutes < input.intervalMinutes) {
    return {
      isDue: false,
      missedPeriodCount: 0,
      coalescedRunCount: 0,
      reason: "尚未到下一个周期。",
    };
  }
  const missedPeriodCount = Math.floor(elapsedMinutes / input.intervalMinutes);
  return {
    isDue: true,
    missedPeriodCount,
    coalescedRunCount: 1,
    reason: `错过 ${String(missedPeriodCount)} 个周期：合并为 1 次待处理，不补跑全部遗漏。`,
  };
}

/** 增量批次：只处理到已提交游标。 */
export function evaluateCurationBatch(input: {
  readonly committedCursor: number;
  readonly availableEntryCount: number;
  readonly maximumBatchSize: number;
}): { readonly batchEntryCount: number; readonly nextCursor: number; readonly leavesNewerForNextRun: boolean } {
  const remaining = Math.max(0, input.committedCursor - 0);
  const maximumBatchSize = Number.isFinite(input.maximumBatchSize)
    ? Math.max(0, Math.trunc(input.maximumBatchSize))
    : 0;
  const batchEntryCount = Math.min(remaining, maximumBatchSize);
  return {
    batchEntryCount,
    nextCursor: batchEntryCount,
    // 正在流入的新内容（> committedCursor）留给下一轮
    leavesNewerForNextRun: input.availableEntryCount > input.committedCursor,
  };
}

/** 运行启动门禁。 */
export type CurationRunStartDecision =
  | { readonly kind: "start"; readonly reason: string }
  | {
      readonly kind: "no-start";
      readonly reasonCode:
        | "rest-period"
        | "budget-exhausted"
        | "cancelled"
        | "authorization-invalid"
        | "authorization-revision-mismatch"
        | "lock-held";
      readonly reason: string;
    };

/**
 * 判定一次周期整理能否真正开始。
 *
 * 次序：取消 → 休息（**休息时不触发模型整理**）→ 授权（revision 必须相符）→ 预算 → 锁。
 */
export function evaluateCurationRunStart(input: {
  readonly isCancelled: boolean;
  readonly isRestPeriod: boolean;
  readonly isAuthorizationValid: boolean;
  readonly authorizedPlanRevision: number;
  readonly currentPlanRevision: number;
  readonly hasBudget: boolean;
  readonly hasLock: boolean;
}): CurationRunStartDecision {
  if (input.isCancelled) {
    return { kind: "no-start", reasonCode: "cancelled", reason: "用户已取消。" };
  }
  if (input.isRestPeriod) {
    return {
      kind: "no-start",
      reasonCode: "rest-period",
      reason: "休息时段不触发模型整理（可延期，不阻塞启动/主对话）。",
    };
  }
  if (!input.isAuthorizationValid) {
    return {
      kind: "no-start",
      reasonCode: "authorization-invalid",
      reason: "授权无效：未授权零自动整理。",
    };
  }
  if (input.authorizedPlanRevision !== input.currentPlanRevision) {
    return {
      kind: "no-start",
      reasonCode: "authorization-revision-mismatch",
      reason: "授权绑定的是旧 revision：需重新授权。",
    };
  }
  if (!input.hasBudget) {
    return {
      kind: "no-start",
      reasonCode: "budget-exhausted",
      reason: "预算不足：暂停并报告，不自行追加。",
    };
  }
  if (input.hasLock) {
    return {
      kind: "no-start",
      reasonCode: "lock-held",
      reason: "已有同方案运行实例：不重复执行。",
    };
  }
  return { kind: "start", reason: "非休息、授权有效且 revision 相符、预算与锁均允许。" };
}

/** 整理结果（失败不得损坏原文或假装覆盖完整）。 */
export interface CurationOutcomeV1 {
  readonly status: "completed" | "failed";
  readonly processedEntryCount: number;
  /** 原文是否保持完整（失败时也必须为 true）。 */
  readonly isOriginalContentIntact: boolean;
  /** 是否声称已覆盖全部（失败时必须为 false）。 */
  readonly claimsFullCoverage: boolean;
  /** 是否有可追溯的失败原因。 */
  readonly failureReason: string | null;
}

export function evaluateCurationOutcome(input: {
  readonly summaryStatus: "succeeded" | "failed";
  readonly processedEntryCount: number;
  readonly failureReason: string | null;
}): CurationOutcomeV1 {
  if (input.summaryStatus === "succeeded") {
    return {
      status: "completed",
      processedEntryCount: input.processedEntryCount,
      isOriginalContentIntact: true,
      claimsFullCoverage: false,
      failureReason: null,
    };
  }
  return {
    status: "failed",
    processedEntryCount: input.processedEntryCount,
    // 摘要失败**不损坏原文**
    isOriginalContentIntact: true,
    // 也**不假装覆盖完整**
    claimsFullCoverage: false,
    failureReason: input.failureReason ?? "摘要失败（未提供原因）。",
  };
}

/** 个体隔离：整理只能处理属于该 Agent 的条目。 */
export function evaluateCurationEntryOwnership(input: {
  readonly entryOwnerAgentInstanceId: string;
  readonly curationAgentInstanceId: string;
}): { readonly isAllowed: boolean; readonly reason: string } {
  return input.entryOwnerAgentInstanceId === input.curationAgentInstanceId
    ? { isAllowed: true, reason: "条目属于该个体：可在其自己的整理范围内处理。" }
    : {
        isAllowed: false,
        reason: "跨个体条目：不得把同级记忆合并进模型上下文（只经受控附件选择）。",
      };
}

/** 重启后续处理：授权仍有效才继续，且沿用原来的游标（不重放）。 */
export function evaluateCurationResume(input: {
  readonly isAuthorizationValid: boolean;
  readonly authorizedPlanRevision: number;
  readonly currentPlanRevision: number;
  readonly committedCursor: number;
}): {
  readonly canResume: boolean;
  readonly effectiveCursor: number;
  readonly reason: string;
} {
  if (!input.isAuthorizationValid) {
    return { canResume: false, effectiveCursor: input.committedCursor, reason: "授权已失效：不自动续处理。" };
  }
  if (input.authorizedPlanRevision !== input.currentPlanRevision) {
    return {
      canResume: false,
      effectiveCursor: input.committedCursor,
      reason: "方案 revision 已变化：需重新授权后再续处理。",
    };
  }
  return {
    canResume: true,
    effectiveCursor: input.committedCursor,
    reason: "授权仍有效：从已提交游标续处理（不重放旧周期）。",
  };
}

/** 运行标识（用于锁与去重）。 */
export function computeCurationRunIdentifier(input: {
  readonly planIdentifier: string;
  readonly planRevision: number;
  readonly scheduledLocalDateIso: string;
}): string {
  return (
    "curation-run:" +
    createHash("sha256")
      .update(JSON.stringify([input.planIdentifier, input.planRevision, input.scheduledLocalDateIso]))
      .digest("hex")
      .slice(0, 24)
  );
}
