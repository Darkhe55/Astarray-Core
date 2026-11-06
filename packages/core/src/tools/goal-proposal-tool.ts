/**
 * R92（2026-11-01）：**模型可提议目标的工具描述符**（③-A）。
 *
 * 目标模式的边界：模型只能**提议**目标（落提案），用户确认后才生成契约。
 * 本文件只定义描述符与权限映射，**不注册进运行时**（避免在能力接线完成前
 * 让模型看到一个"能调但执行未接"的工具）。
 *
 * ③-B 会做：目标模式激活时把该描述符加入任务工具集，并把执行接到
 * `proposeGoalContract`。
 */
import type { ToolCallResult, ToolDescriptor } from "../core/types.js";
import type { GoalContractProposalDraft } from "../orchestration/goal-contract-proposal.js";

export const GOAL_PROPOSAL_TOOL_NAME = "proposeGoal";

export const GOAL_PROPOSAL_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: GOAL_PROPOSAL_TOOL_NAME,
  summary:
    "提议一个目标（只生成待确认提案；不会自动启用目标模式，也不会创建契约）",
  /**
   * AUDIT-REPAIR-01（2026-11-06）：提案会**落盘**，不能声明只读/无变更。
   * 使用现有"仅新建"类别：提案文件创建后不被覆盖；由调用侧 callId 幂等防重。
   */
  category: "restricted",
  mutationKind: "create-only",
  backupPolicy: "not-required",
  authorizationPolicy: "standard",
  supportedTaskTypes: ["data", "doc", "code"],
  /** 同一 callId 重试由处理器去重；不同调用各自落提案。 */
  isIdempotent: true,
  inputSchema: {
    type: "object",
    properties: {
      objectiveText: { type: "string" },
      sourceRequestReference: { type: "string" },
      requirements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requirementIdentifier: { type: "string" },
            description: { type: "string" },
            weight: { type: "number" },
            completionPredicateKind: {
              type: "string",
              enum: ["deterministic-check", "independent-acceptance"],
            },
          },
          required: ["requirementIdentifier", "description", "weight"],
        },
      },
    },
    required: ["objectiveText", "requirements"],
  },
};

/**
 * AUDIT-REPAIR-01（2026-11-06）：`proposeGoal` 的处理器。
 *
 * 与旧实现的关键区别：旧代码在 worker 工具端口里**绕过** `policyPort.execute`；
 * 现在处理器只负责"校验 + 落提案"，权限/门禁/审批全部由 PolicyWrapper 先行处理。
 *
 * 幂等：同一 `callId` 重复调用返回同一提案结果（不重复落盘）；不同 callId 各自落提案。
 */
export function createGoalProposalToolHandler(input: {
  readonly isGoalModeActivated: () => boolean;
  readonly missionIdentifier: string | undefined;
  readonly proposeGoalContract: (request: {
    readonly draft: GoalContractProposalDraft;
    readonly sourceRequestReference: string;
  }) => Promise<{ readonly proposalIdentifier: string; readonly expiresAtIso: string }>;
}): (argumentsJson: string, callId: string) => Promise<ToolCallResult> {
  const proposalIdentifierByCallId = new Map<string, string>();
  return async (argumentsJson, callId) => {
    if (!input.isGoalModeActivated()) {
      return {
        kind: "error",
        callId,
        errorCode: "goal-mode-not-active",
        errorMessage: "目标模式未激活：不能提议目标。",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      };
    }
    if (input.missionIdentifier === undefined) {
      return {
        kind: "error",
        callId,
        errorCode: "mission-context-missing",
        errorMessage: "缺少 mission 上下文：无法为提案生成来源引用。",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      };
    }
    const previousProposalIdentifier = proposalIdentifierByCallId.get(callId);
    if (previousProposalIdentifier !== undefined) {
      return {
        kind: "success",
        callId,
        outputText: `目标提案已创建: ${previousProposalIdentifier}（需用户确认；owner 确认后才生成契约）`,
        isSideEffectFree: false,
      };
    }
    let parsedArguments: { objectiveText?: unknown; requirements?: unknown };
    try {
      parsedArguments = JSON.parse(argumentsJson) as typeof parsedArguments;
    } catch {
      return {
        kind: "error",
        callId,
        errorCode: "invalid-arguments",
        errorMessage: "proposeGoal 参数不是合法 JSON。",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      };
    }
    if (
      typeof parsedArguments.objectiveText !== "string" ||
      parsedArguments.objectiveText.trim() === ""
    ) {
      return {
        kind: "error",
        callId,
        errorCode: "invalid-arguments",
        errorMessage: "proposeGoal 缺少非空 objectiveText。",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      };
    }
    if (!Array.isArray(parsedArguments.requirements)) {
      return {
        kind: "error",
        callId,
        errorCode: "invalid-arguments",
        errorMessage: "proposeGoal 的 requirements 必须是数组。",
        isIdempotencyConfirmed: true,
        sideEffectStatus: "none",
      };
    }
    const draft: GoalContractProposalDraft = {
      objectiveText: parsedArguments.objectiveText,
      requirements: parsedArguments.requirements as GoalContractProposalDraft["requirements"],
      scope: { projectIdentifiers: [], allowedToolNames: null },
      nonViolableInvariants: [],
      resourceLimits: {
        maximumToolCalls: null,
        maximumWallClockSeconds: null,
        maximumCostUnits: null,
      },
      deadlineIso: null,
      pauseConditions: [],
    };
    try {
      const proposal = await input.proposeGoalContract({
        draft,
        sourceRequestReference: `mission:${input.missionIdentifier}`,
      });
      proposalIdentifierByCallId.set(callId, proposal.proposalIdentifier);
      return {
        kind: "success",
        callId,
        outputText: `目标提案已创建: ${proposal.proposalIdentifier}（需用户确认；owner 确认后才生成契约）`,
        isSideEffectFree: false,
      };
    } catch (error) {
      return {
        kind: "error",
        callId,
        errorCode: "goal-proposal-invalid",
        errorMessage: (error as Error).message,
        isIdempotencyConfirmed: false,
        sideEffectStatus: "unknown",
      };
    }
  };
}
