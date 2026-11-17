/**
 * P4：上下文阶段策略。
 *
 * 完整内核在规划、执行、验收和回访阶段关注的信息不同：
 * - 规划阶段需要更多全局决策和接口/产物契约；
 * - 执行阶段需要把预算留给当前局部节点、工具结果和证据；
 * - 验收阶段需要保留验收标准、测试证据和用户偏好；
 * - 回访阶段只为已关闭节点留出有限预算。
 *
 * 第一版采用确定性比例，不引入学习型网络。比例只调整“历史/注入”预算，
 * 系统规则、当前任务和输出预留仍由 P1 的容量规划器先行扣除。
 */
import { DomainError } from "../core/errors.js";

export const CONTEXT_PHASES = [
  "planning",
  "execution",
  "verification",
  "recall",
] as const;

export type ContextPhase = (typeof CONTEXT_PHASES)[number];

export interface ContextPhasePolicy {
  readonly historyTokenRatio: number;
  readonly promptTokenRatio: number;
}

export const DEFAULT_CONTEXT_PHASE_POLICIES: Readonly<
  Record<ContextPhase, ContextPhasePolicy>
> = {
  planning: { historyTokenRatio: 1, promptTokenRatio: 1 },
  execution: { historyTokenRatio: 0.75, promptTokenRatio: 0.9 },
  verification: { historyTokenRatio: 0.6, promptTokenRatio: 0.8 },
  recall: { historyTokenRatio: 0.5, promptTokenRatio: 0.7 },
};

export interface ContextPhaseBudgetInput {
  readonly phase: ContextPhase;
  readonly configuredHistoryTokenCount: number;
  readonly maximumPromptTokenCount?: number | undefined;
  readonly policy?: ContextPhasePolicy | undefined;
}

export interface ContextPhaseBudget {
  readonly phase: ContextPhase;
  readonly historyTokenCount: number;
  readonly maximumPromptTokenCount: number | null;
  readonly policy: ContextPhasePolicy;
}

function isRatio(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function resolveContextPhaseBudget(
  input: ContextPhaseBudgetInput,
): ContextPhaseBudget {
  if (!CONTEXT_PHASES.includes(input.phase)) {
    throw new DomainError("context-budget-invalid", `unknown context phase: ${input.phase}`);
  }
  if (
    !Number.isInteger(input.configuredHistoryTokenCount) ||
    input.configuredHistoryTokenCount < 0
  ) {
    throw new DomainError(
      "context-budget-invalid",
      "configuredHistoryTokenCount must be a non-negative integer",
    );
  }
  const policy = input.policy ?? DEFAULT_CONTEXT_PHASE_POLICIES[input.phase];
  if (!isRatio(policy.historyTokenRatio) || !isRatio(policy.promptTokenRatio)) {
    throw new DomainError(
      "context-budget-invalid",
      "context phase ratios must be between 0 and 1",
    );
  }
  if (
    input.maximumPromptTokenCount !== undefined &&
    (!Number.isInteger(input.maximumPromptTokenCount) ||
      input.maximumPromptTokenCount < 0)
  ) {
    throw new DomainError(
      "context-budget-invalid",
      "maximumPromptTokenCount must be a non-negative integer",
    );
  }
  return {
    phase: input.phase,
    historyTokenCount: Math.floor(
      input.configuredHistoryTokenCount * policy.historyTokenRatio,
    ),
    maximumPromptTokenCount:
      input.maximumPromptTokenCount === undefined
        ? null
        : Math.floor(input.maximumPromptTokenCount * policy.promptTokenRatio),
    policy,
  };
}
