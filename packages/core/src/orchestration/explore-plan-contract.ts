/**
 * EXPLORE-01-01（EXP-01，2026-10-18 R11）：**边界探索的问题指纹、计划与独立预算/触发/停止契约**。
 *
 * 卡内依据（`docs/tasks/EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS.md` §3）：
 * - 「多次出现**同一可定位问题**且已有方案无进展时，模型可提出探索计划。本地结合**问题指纹**、
 *   失败证据和进展记录**去重确认**，**不把所有失败归成同一个问题**」；
 * - 计划需列：问题、已试方法、待验证假设、候选方向、数据/工具范围、**停止条件**和**独立预算**；
 * - 「只有用户启用并**允许当前范围**、当前可用资源满足时才启动；**资源未知时使用用户批准的本地预算，
 *   不猜余额**。预算不足先报告或等待，**不购买额度、不自动切换未授权模型**」；
 * - 预算含总墙钟时间、模型请求/token、最大试验数、并发和可选金额估算，**持久化扣减**，
 *   **不通过新建子 Agent 重置**；试验并发不超会话资源限制；**正常用户任务优先**；
 * - 「**不重复探索相同参数和版本组合**，允许记录阴性结果」；
 * - 「无进展、达到预算、用户撤销、休息时段、持续工具失败或环境异常时停止/暂停，
 *   **不自发再申请另一轮绕过预算**」。
 *
 * ## 边界
 * 纯判定：不启动探索、不调用模型、不写盘、不扣费。扣减与持久化由调用方按本契约执行。
 */
import { createHash } from "node:crypto";

/** 探索预算（各维度独立，**持久化扣减**）。 */
export interface ExplorationBudget {
  readonly wallClockMinutes: number;
  readonly modelRequests: number;
  readonly tokens: number;
  readonly maximumTrials: number;
  readonly concurrency: number;
  /** 可选金额估算（**不是**官方余额；不得据此推断可用额度）。 */
  readonly estimatedCostAmount: number | null;
}

/**
 * 问题指纹：**同一可定位问题**的判定依据。
 *
 * 组成：问题签名 + 失败证据标识（排序去重）+ 参与版本。
 * 刻意**不包含**"相似度"或模型判断 —— 指纹只回答"是不是同一问题/同一版本组合"。
 */
export function computeExplorationProblemFingerprint(input: {
  readonly problemSignature: string;
  readonly failureEvidenceIdentifiers: ReadonlyArray<string>;
  readonly versionIdentifier: string;
}): string {
  const normalizedEvidence = [...new Set(input.failureEvidenceIdentifiers.map((item) => item.trim()))]
    .filter((item) => item !== "")
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.problemSignature.trim(),
        normalizedEvidence,
        input.versionIdentifier.trim(),
      ]),
    )
    .digest("hex");
}

/** 探索计划（卡内点名的字段，缺一即拒）。 */
export interface ExplorationPlanInput {
  readonly problemDescription: string;
  readonly triedApproaches: ReadonlyArray<string>;
  readonly hypothesesToVerify: ReadonlyArray<string>;
  readonly candidateDirections: ReadonlyArray<string>;
  readonly dataAndToolScope: string;
  readonly stopConditions: ReadonlyArray<string>;
  readonly budget: ExplorationBudget;
  /** 参与试验的参数组合（用于"不重复探索相同参数和版本组合"）。 */
  readonly parameterCombinationIdentifier: string;
  readonly versionIdentifier: string;
}

export type ExplorationPlanAssessment =
  | { readonly kind: "accepted"; readonly plan: ExplorationPlanInput; readonly fingerprint: string }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "missing-required-field"
        | "no-stop-conditions"
        | "invalid-budget"
        | "no-tried-approaches"
        | "no-hypotheses";
      readonly reason: string;
    };

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** 校验探索计划（fail-closed）。 */
export function assessExplorationPlan(plan: ExplorationPlanInput): ExplorationPlanAssessment {
  if (plan.problemDescription.trim() === "" || plan.dataAndToolScope.trim() === "") {
    return {
      kind: "rejected",
      reasonCode: "missing-required-field",
      reason: "缺少问题描述或数据/工具范围。",
    };
  }
  if (plan.triedApproaches.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "no-tried-approaches",
      reason: "必须列出已试方法：否则无法证明'已有方案无进展'。",
    };
  }
  if (plan.hypothesesToVerify.length === 0 || plan.candidateDirections.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "no-hypotheses",
      reason: "必须列出待验证假设与候选方向。",
    };
  }
  if (plan.stopConditions.length === 0 || plan.stopConditions.some((item) => item.trim() === "")) {
    return {
      kind: "rejected",
      reasonCode: "no-stop-conditions",
      reason: "缺少停止条件：不允许无界探索。",
    };
  }
  const budget = plan.budget;
  if (
    !isPositiveFinite(budget.wallClockMinutes) ||
    !isPositiveFinite(budget.modelRequests) ||
    !isPositiveFinite(budget.tokens) ||
    !isPositiveFinite(budget.maximumTrials) ||
    !isPositiveFinite(budget.concurrency) ||
    (budget.estimatedCostAmount !== null &&
      (!Number.isFinite(budget.estimatedCostAmount) || budget.estimatedCostAmount < 0))
  ) {
    return {
      kind: "rejected",
      reasonCode: "invalid-budget",
      reason: "预算必须为正的有限数（金额估算可为 null 或非负）。",
    };
  }
  const fingerprint = computeExplorationProblemFingerprint({
    problemSignature: plan.problemDescription,
    failureEvidenceIdentifiers: [],
    versionIdentifier: plan.versionIdentifier,
  });
  return { kind: "accepted", plan, fingerprint };
}

/** 启动判定结论。 */
export type ExplorationStartDecision =
  | {
      readonly kind: "start";
      readonly isPriorityBelowUserTasks: true;
      readonly canSelfRenewBudget: false;
      readonly reason: string;
    }
  | {
      readonly kind: "no-start";
      readonly reasonCode:
        | "disabled"
        | "scope-not-authorized"
        | "resource-unknown"
        | "budget-exhausted"
        | "duplicate-combination"
        | "concurrency-exceeds-session-limit";
      readonly reason: string;
    };

/**
 * 判定能否启动探索。
 *
 * 次序：实验开关（**默认关**）→ 当前范围是否用户允许 → 资源状态（未知则必须有
 * **用户批准的本地预算**，否则不启动且**不猜余额**）→ 预算是否已耗尽 → 相同参数/版本组合是否已探索 →
 * 并发是否超会话限制。
 */
export function evaluateExplorationStart(input: {
  readonly isExperimentEnabled: boolean | undefined;
  readonly isCurrentScopeAuthorizedByUser: boolean;
  readonly isResourceStateUnknown: boolean;
  readonly hasUserApprovedLocalBudget: boolean;
  readonly budget: ExplorationBudget;
  readonly sessionConcurrencyLimit: number;
  readonly exploredCombinationFingerprints: ReadonlyArray<string>;
  readonly targetCombinationFingerprint: string;
}): ExplorationStartDecision {
  if (input.isExperimentEnabled !== true) {
    return { kind: "no-start", reasonCode: "disabled", reason: "实验性探索默认关闭。" };
  }
  if (!input.isCurrentScopeAuthorizedByUser) {
    return {
      kind: "no-start",
      reasonCode: "scope-not-authorized",
      reason: "用户未允许当前范围：不得在该范围启动探索。",
    };
  }
  if (input.isResourceStateUnknown && !input.hasUserApprovedLocalBudget) {
    return {
      kind: "no-start",
      reasonCode: "resource-unknown",
      reason: "资源状态未知且没有用户批准的本地预算：不启动，也不猜余额。",
    };
  }
  const { budget } = input;
  if (
    !isPositiveFinite(budget.wallClockMinutes) ||
    !isPositiveFinite(budget.modelRequests) ||
    !isPositiveFinite(budget.tokens) ||
    !isPositiveFinite(budget.maximumTrials)
  ) {
    return {
      kind: "no-start",
      reasonCode: "budget-exhausted",
      reason: "预算已耗尽或无有效预算：先报告或等待，不购买额度、不自动切换未授权模型。",
    };
  }
  if (input.exploredCombinationFingerprints.includes(input.targetCombinationFingerprint)) {
    return {
      kind: "no-start",
      reasonCode: "duplicate-combination",
      reason: "相同参数与版本组合已探索过：不重复探索（阴性结果仍应记录）。",
    };
  }
  if (
    !Number.isFinite(input.sessionConcurrencyLimit) ||
    budget.concurrency > input.sessionConcurrencyLimit
  ) {
    return {
      kind: "no-start",
      reasonCode: "concurrency-exceeds-session-limit",
      reason: "试验并发超过会话资源限制：先降低并发。",
    };
  }
  return {
    kind: "start",
    isPriorityBelowUserTasks: true,
    canSelfRenewBudget: false,
    reason: "开关开启、范围已授权、资源满足、组合未探索且并发在限内。",
  };
}

/** 预算扣减结论。 */
export type BudgetConsumptionOutcome =
  | { readonly kind: "consumed"; readonly remaining: ExplorationBudget }
  | { readonly kind: "exhausted"; readonly remaining: ExplorationBudget; readonly reason: string };

/**
 * 扣减预算（**不透支**）。
 *
 * 任一维度不足 ⇒ `exhausted` 且**不扣减**（避免"扣一半又失败"的半状态）。
 */
export function applyExplorationBudgetConsumption(input: {
  readonly budget: ExplorationBudget;
  readonly consumed: {
    readonly wallClockMinutes: number;
    readonly modelRequests: number;
    readonly tokens: number;
    readonly trials: number;
  };
}): BudgetConsumptionOutcome {
  const { budget, consumed } = input;
  const isInsufficient =
    consumed.wallClockMinutes > budget.wallClockMinutes ||
    consumed.modelRequests > budget.modelRequests ||
    consumed.tokens > budget.tokens ||
    consumed.trials > budget.maximumTrials;
  if (isInsufficient) {
    return {
      kind: "exhausted",
      remaining: budget,
      reason: "预算不足：先报告或等待，不自行追加预算。",
    };
  }
  return {
    kind: "consumed",
    remaining: {
      ...budget,
      wallClockMinutes: budget.wallClockMinutes - consumed.wallClockMinutes,
      modelRequests: budget.modelRequests - consumed.modelRequests,
      tokens: budget.tokens - consumed.tokens,
      maximumTrials: budget.maximumTrials - consumed.trials,
      estimatedCostAmount: budget.estimatedCostAmount,
    },
  };
}

/** 停止/暂停判定。 */
export type ExplorationStopDecision =
  | {
      readonly kind: "stop";
      readonly reasonCode:
        | "no-progress"
        | "budget-reached"
        | "user-cancelled"
        | "rest-period"
        | "tool-failures"
        | "environment-abnormal";
      readonly reason: string;
      readonly canSelfRenewBudget: false;
    }
  | { readonly kind: "continue"; readonly reason: string };

/**
 * 判定是否必须停止/暂停（任一命中即停）。
 *
 * 卡内：无进展、达到预算、用户撤销、休息时段、持续工具失败或环境异常 ⇒ 停止/暂停，
 * **不自发再申请另一轮绕过预算**。
 */
export function evaluateExplorationStop(input: {
  readonly consecutiveNoProgressRounds: number;
  readonly maximumNoProgressRounds: number;
  readonly isBudgetReached: boolean;
  readonly isUserCancelled: boolean;
  readonly isRestPeriod: boolean;
  readonly consecutiveToolFailureCount: number;
  readonly maximumToolFailureCount: number;
  readonly isEnvironmentAbnormal: boolean;
}): ExplorationStopDecision {
  if (input.isUserCancelled) {
    return {
      kind: "stop",
      reasonCode: "user-cancelled",
      reason: "用户已撤销。",
      canSelfRenewBudget: false,
    };
  }
  if (input.isRestPeriod) {
    return {
      kind: "stop",
      reasonCode: "rest-period",
      reason: "处于休息时段：暂停，不发起新的模型请求。",
      canSelfRenewBudget: false,
    };
  }
  if (input.isBudgetReached) {
    return {
      kind: "stop",
      reasonCode: "budget-reached",
      reason: "预算已达上限：停止并报告，不自行追加。",
      canSelfRenewBudget: false,
    };
  }
  if (input.isEnvironmentAbnormal) {
    return {
      kind: "stop",
      reasonCode: "environment-abnormal",
      reason: "环境异常：暂停并如实报告。",
      canSelfRenewBudget: false,
    };
  }
  if (
    Number.isFinite(input.maximumToolFailureCount) &&
    input.consecutiveToolFailureCount >= input.maximumToolFailureCount
  ) {
    return {
      kind: "stop",
      reasonCode: "tool-failures",
      reason: "连续工具失败达到上限：停止并报告。",
      canSelfRenewBudget: false,
    };
  }
  if (
    Number.isFinite(input.maximumNoProgressRounds) &&
    input.consecutiveNoProgressRounds >= input.maximumNoProgressRounds
  ) {
    return {
      kind: "stop",
      reasonCode: "no-progress",
      reason: "连续无进展达到上限：停止，不进入无限续跑。",
      canSelfRenewBudget: false,
    };
  }
  return { kind: "continue", reason: "未命中任何停止条件。" };
}
