/**
 * WIRING-04-05（2026-11-17）：**回访工具调用的适配层**。
 *
 * 卡内要求：
 * - 运行中的临时历史需求通过**工具请求**发起；
 * - 调用者身份由 **harness 注入**，不取自模型参数；
 * - 请求必须绑定节点、固定 revision、原因码与预算；
 * - 结果进入工具响应（或登记为 `recalledContextBlocks`），**不得两处重复注入**；
 * - 回访不重开节点、不恢复任务、不修改原始档案。
 *
 * 本模块只做"工具调用 → 控制器"的转换与形状收敛，便于在没有完整运行时装配时先验证语义。
 */
import type { ContextRecallResult } from "./context-recall-controller.js";

export interface RecallToolCallOutcome {
  readonly isOk: boolean;
  /** 工具响应正文（失败时是**明确拒绝**，不是静默空串）。 */
  readonly contentText: string;
}

export async function executeRecallToolCall(input: {
  /** harness 注入的调用者身份（**不来自模型参数**）。 */
  readonly callerAgentInstanceId: string;
  readonly argumentsJson: string;
  readonly recall: (input: {
    callerAgentInstanceId: string;
    request: unknown;
  }) => Promise<ContextRecallResult>;
  /**
   * WIRING-04-05：**最小候选引用**（只给标识与固定 revision，**不给正文**）。
   *
   * 仅当节点找不到时随拒绝一起返回，让 Agent 用已有读取权限重试，
   * 而不是让模型自己猜节点名。
   */
  readonly listCandidateReferences?: (
    callerAgentInstanceId: string,
  ) => Promise<
    ReadonlyArray<{ readonly contextNodeIdentifier: string; readonly sourceRevision: number }>
  >;
}): Promise<RecallToolCallOutcome> {
  if (input.callerAgentInstanceId.trim() === "") {
    return {
      isOk: false,
      contentText: JSON.stringify({
        status: "refused",
        errorCode: "context-recall-invalid",
        reason: "调用者身份缺失（由 harness 注入）",
      }),
    };
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(input.argumentsJson);
  } catch {
    return {
      isOk: false,
      contentText: JSON.stringify({
        status: "refused",
        errorCode: "context-recall-invalid",
        reason: "参数不是合法 JSON",
      }),
    };
  }
  if (parsedArguments === null || typeof parsedArguments !== "object") {
    return {
      isOk: false,
      contentText: JSON.stringify({
        status: "refused",
        errorCode: "context-recall-invalid",
        reason: "参数必须是对象",
      }),
    };
  }
  const argumentRecord = parsedArguments as Record<string, unknown>;
  /** 模型参数里若出现调用者身份 ⇒ 拒绝（身份只能由 harness 注入）。 */
  if (argumentRecord["callerAgentInstanceId"] !== undefined) {
    return {
      isOk: false,
      contentText: JSON.stringify({
        status: "refused",
        errorCode: "context-recall-invalid",
        reason: "调用者身份不得由模型提供",
      }),
    };
  }

  const result = await input.recall({
    callerAgentInstanceId: input.callerAgentInstanceId,
    request: parsedArguments,
  });
  if (result.status === "not-found" && input.listCandidateReferences !== undefined) {
    /** 找不到 ⇒ 附**最小候选引用**（标识 + revision），正文仍必须另行请求。 */
    const candidateReferences = await input
      .listCandidateReferences(input.callerAgentInstanceId)
      .catch(() => []);
    return {
      isOk: false,
      contentText: JSON.stringify({
        status: "not-found",
        candidates: candidateReferences.slice(0, 5),
        hint: "候选只给标识与 revision；正文需再次请求并说明原因码",
      }),
    };
  }
  return {
    isOk: result.status === "ok" || result.status === "repeat-receipt",
    contentText: JSON.stringify(result),
  };
}
