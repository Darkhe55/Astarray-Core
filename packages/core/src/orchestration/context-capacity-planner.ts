/**
 * Context capacity planning for the complete kernel.
 *
 * The provider's declared input space is the total space available for the
 * request, not the space available for historical context. System rules,
 * current task text, tool documentation and the output reserve must be
 * subtracted first. This planner keeps that arithmetic in one place so the
 * assembler can fail closed with an explainable reduction reason.
 */
import { DomainError } from "../core/errors.js";

export interface ContextCapacityInput {
  /** Provider/model input space in tokens. Unknown/undefined means no hard model cap. */
  readonly modelInputSpaceTokens?: number | null | undefined;
  /** User-configured maximum for the injectable history/global context. */
  readonly configuredHistoryTokenCount: number;
  /** System rules and mandatory protocol text that are always injected. */
  readonly systemRulesTokenCount?: number | undefined;
  /** Current task description/instructions that are always injected. */
  readonly taskTokenCount?: number | undefined;
  /** Tool documentation/tool schema overhead. */
  readonly toolDocumentationTokenCount?: number | undefined;
  /** Space reserved for the model's output. */
  readonly outputReserveTokenCount?: number | undefined;
  /** Message/protocol wrapper overhead not captured by the categories above. */
  readonly protocolOverheadTokenCount?: number | undefined;
  /** Pre-aggregated reserved tokens, for callers that already measured them. */
  readonly reservedInputTokens?: number | undefined;
}

export interface ContextCapacityPlan {
  readonly configuredHistoryTokenCount: number;
  readonly effectiveHistoryTokenCount: number;
  readonly modelInputSpaceTokens: number | null;
  readonly reservedInputTokens: number;
  readonly availableHistoryTokens: number | null;
  readonly isModelWindowKnown: boolean;
  readonly budgetReductionReason: string | null;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError(
      "context-budget-invalid",
      `${field} must be a non-negative integer`,
    );
  }
  return value;
}

export function planContextCapacity(input: ContextCapacityInput): ContextCapacityPlan {
  const configured = requireNonNegativeInteger(
    input.configuredHistoryTokenCount,
    "configuredHistoryTokenCount",
  );
  const reserved =
    requireNonNegativeInteger(input.systemRulesTokenCount ?? 0, "systemRulesTokenCount") +
    requireNonNegativeInteger(input.taskTokenCount ?? 0, "taskTokenCount") +
    requireNonNegativeInteger(
      input.toolDocumentationTokenCount ?? 0,
      "toolDocumentationTokenCount",
    ) +
    requireNonNegativeInteger(
      input.outputReserveTokenCount ?? 0,
      "outputReserveTokenCount",
    ) +
    requireNonNegativeInteger(
      input.protocolOverheadTokenCount ?? 0,
      "protocolOverheadTokenCount",
    ) +
    requireNonNegativeInteger(input.reservedInputTokens ?? 0, "reservedInputTokens");

  if (
    input.modelInputSpaceTokens === undefined ||
    input.modelInputSpaceTokens === null
  ) {
    return {
      configuredHistoryTokenCount: configured,
      effectiveHistoryTokenCount: configured,
      modelInputSpaceTokens: null,
      reservedInputTokens: reserved,
      availableHistoryTokens: null,
      isModelWindowKnown: false,
      budgetReductionReason: null,
    };
  }

  const modelSpace = requireNonNegativeInteger(
    input.modelInputSpaceTokens,
    "modelInputSpaceTokens",
  );
  const availableHistoryTokens = Math.max(0, modelSpace - reserved);
  const effective = Math.min(configured, availableHistoryTokens);
  return {
    configuredHistoryTokenCount: configured,
    effectiveHistoryTokenCount: effective,
    modelInputSpaceTokens: modelSpace,
    reservedInputTokens: reserved,
    availableHistoryTokens,
    isModelWindowKnown: true,
    budgetReductionReason:
      effective < configured
        ? "Provider 输入空间扣除系统规则、当前任务、工具说明和输出预留后不足以容纳配置的历史预算"
        : null,
  };
}
