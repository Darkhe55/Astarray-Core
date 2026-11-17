/**
 * P1-2 要求 1（2026-11-17）：**权威完成校验只保留一套**。
 *
 * 此前两条入口各写一套宽严不同的判定：
 * - Worker 收口：`evaluateCompletionReceipt`（可配置是否必需，默认关闭）；
 * - 协调入口：协调门禁（来源/项目/任务状态/审查状态/完成收据）。
 *
 * 两套并存的风险是"宽的那条被当成后门"。本模块把它们合并成**一次调用**，
 * 两条路径都必须经过它；是否强制收据由调用方传入的既有配置决定（不改变默认开关）。
 */
import { evaluateCompletionReceipt } from "./completion-receipt.js";
import {
  evaluateCoordinationCompletion,
  type CoordinationCompletionCode,
} from "./coordination-completion-gate.js";

export interface AuthoritativeCompletionDecision {
  readonly isAccepted: boolean;
  readonly code: CoordinationCompletionCode | "completion-receipt-insufficient";
  readonly reason: string;
}

export function evaluateAuthoritativeCompletion(input: {
  readonly outcome: "done" | "failed";
  readonly sourceAgentInstanceIdentifier: string | null;
  readonly messageMissionIdentifier: string | null;
  readonly messageProjectIdentifier: string | null;
  readonly task: {
    readonly id: string;
    readonly status: string;
    readonly assignedAgentId: string | null;
    readonly taskType?: string;
  } | null;
  readonly missionProjectIdentifier: string | null;
  readonly completionReceipt: unknown | null;
  readonly requiresCompletionControlEvent: boolean;
  /** 是否**强制**要求完成收据（沿用各入口既有配置，不在此改变默认值）。 */
  readonly isCompletionReceiptRequired: boolean;
  readonly reviewState: "none" | "pending" | "rework" | "accepted";
  /**
   * 入口种类：`coordination-message` 需要校验消息侧的 mission/project 声明；
   * `worker` 是进程内受派收口，不涉及消息声明，但同样要过收据与审查状态。
   */
  readonly entryKind?: "coordination-message" | "worker";
  /** WIRING-04-04：版本/尝试（双方都有值时才比较）。 */
  readonly messageTaskRevision?: number | null;
  readonly messageExecutionAttempt?: number | null;
  readonly currentTaskRevision?: number | null;
  readonly currentExecutionAttempt?: number | null;
}): AuthoritativeCompletionDecision {
  /** 1) 收据校验（仅在要求时；沿用既有 `evaluateCompletionReceipt`，不重写规则）。 */
  if (input.outcome === "done" && input.isCompletionReceiptRequired) {
    const receiptEvaluation = evaluateCompletionReceipt({
      receipt: input.completionReceipt as never,
      requiresCompletionControlEvent: input.requiresCompletionControlEvent,
    });
    if (!receiptEvaluation.isSufficient) {
      return {
        isAccepted: false,
        code: "completion-receipt-insufficient",
        reason: receiptEvaluation.reasons.join("；"),
      };
    }
  }

  /** 2) 来源/项目/任务状态/审查状态/收据标识（协调门禁的同一套规则）。 */
  return evaluateCoordinationCompletion({
    outcome: input.outcome,
    sourceAgentInstanceIdentifier: input.sourceAgentInstanceIdentifier,
    messageMissionIdentifier: input.messageMissionIdentifier,
    messageProjectIdentifier: input.messageProjectIdentifier,
    task: input.task,
    missionProjectIdentifier: input.missionProjectIdentifier,
    completionReceiptIdentifier:
      input.completionReceipt === null || input.completionReceipt === undefined
        ? null
        : "completion-receipt",
    reviewState: input.reviewState,
    ...(input.entryKind === undefined ? {} : { entryKind: input.entryKind }),
    ...(input.messageTaskRevision === undefined
      ? {}
      : { messageTaskRevision: input.messageTaskRevision }),
    ...(input.messageExecutionAttempt === undefined
      ? {}
      : { messageExecutionAttempt: input.messageExecutionAttempt }),
    ...(input.currentTaskRevision === undefined
      ? {}
      : { currentTaskRevision: input.currentTaskRevision }),
    ...(input.currentExecutionAttempt === undefined
      ? {}
      : { currentExecutionAttempt: input.currentExecutionAttempt }),
  });
}
