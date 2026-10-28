/**
 * ALIGN-03-03（2026-10-28）：**完成收据**契约。
 *
 * 卡内要求：真实工具结果、产物记录和明确完成标识进入本地完成门禁；失败/中断只报原因，
 * **不伪造 done**；早停从检查点有界续跑，不拿下一组任务掩盖未完成组。
 *
 * 现状（本轮核对）：worker 已在本地检查"完成控制事件是否存在、写工具是否全部成功、
 * 产物是否落盘"，但**编排层**只要拿到 `outcome: "success"` 就直接 `finishTask(done)`，
 * 没有任何可核对的"完成收据"；而 `LocalCompletionVerifier` 至今**零调用方**。
 *
 * 本模块定义 worker → 编排层的**收据**，并提供纯判定：
 * - 收据字段全部来自 worker 的**真实本地状态**（工具调用数、落盘产物、完成事件校验结果），
 *   不是模型自述；
 * - 编排层在 `isCompletionReceiptRequired` 时可要求收据齐备，否则**不判 done**
 *   （block + 升级，原因如实给出）；
 * - 收据缺失/矛盾时**绝不**补一个默认收据。
 */
import { DomainError } from "../core/errors.js";

export interface CompletionReceipt {
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  /** 是否成功校验了 `ASTARRAY_TASK_COMPLETION_V1` 完成控制事件（`requireCompletionEvent` 时）。 */
  readonly hasVerifiedCompletionControlEvent: boolean;
  /** 本次实际发生的工具调用数（真实本地计数，不是模型说法）。 */
  readonly toolCallCount: number;
  /** 实际落盘的产物路径（本地记录）。 */
  readonly artifactPaths: readonly string[];
  readonly recordedAtIso: string;
}

export interface EvaluateCompletionReceiptInput {
  readonly receipt: CompletionReceipt | null;
  readonly requiresCompletionControlEvent: boolean;
}

export interface CompletionReceiptEvaluation {
  readonly isSufficient: boolean;
  readonly reasons: readonly string[];
}

/**
 * 判定收据是否足以支撑"done"。
 *
 * 规则刻意保守：**缺失即不足**（不补默认收据）；要求完成事件时收据必须声明已校验；
 * 有产物声明却无落盘路径视为矛盾（宁可 block 也不谎报完成）。
 */
export function evaluateCompletionReceipt(
  input: EvaluateCompletionReceiptInput,
): CompletionReceiptEvaluation {
  const reasons: string[] = [];
  const receipt = input.receipt;
  if (receipt === null) {
    reasons.push("缺少完成收据：Worker 未提供可核对的本地完成记录");
    return { isSufficient: false, reasons };
  }
  if (receipt.taskIdentifier.trim() === "") {
    reasons.push("完成收据缺少任务标识");
  }
  if (receipt.missionIdentifier.trim() === "") {
    reasons.push("完成收据缺少 mission 标识");
  }
  if (!Number.isInteger(receipt.toolCallCount) || receipt.toolCallCount < 0) {
    reasons.push("完成收据的工具调用计数非法");
  }
  if (input.requiresCompletionControlEvent && !receipt.hasVerifiedCompletionControlEvent) {
    reasons.push("要求完成控制事件，但收据未声明已校验该事件");
  }
  if (
    receipt.artifactPaths.some(
      (artifactPath) => typeof artifactPath !== "string" || artifactPath.trim() === "",
    )
  ) {
    reasons.push("完成收据包含空的产物路径");
  }
  return { isSufficient: reasons.length === 0, reasons };
}

/** 构造收据（仅供 worker 在成功分支调用；字段必须来自真实本地状态）。 */
export function buildCompletionReceipt(input: CompletionReceipt): CompletionReceipt {
  if (input.taskIdentifier.trim() === "") {
    throw new DomainError("invalid-task-chain", "完成收据必须绑定具体任务标识。");
  }
  return {
    missionIdentifier: input.missionIdentifier,
    taskIdentifier: input.taskIdentifier,
    hasVerifiedCompletionControlEvent: input.hasVerifiedCompletionControlEvent,
    toolCallCount: input.toolCallCount,
    artifactPaths: [...input.artifactPaths],
    recordedAtIso: input.recordedAtIso,
  };
}
