/**
 * GOAL-02-01（2026-10-28）：**冻结目标契约与候选势函数**。
 *
 * 卡内边界（必须先说清）：
 * - 保留用户原文为**优化目标**，**不宣传**"已证明永不偏航"；
 * - 开放世界行动与外部扰动无法仅凭评分保证；首版是"**受约束目标推进**"，不是新权限模式；
 * - 与思索/协同/放权正交、**默认关闭**、仅认证用户开启；
 * - 模型建议**不能**自改目标、删要求或降低判准；
 * - `V = 0` 只表示"当前已枚举要求具有有效证据"，**不等于**现实世界完整正确；
 * - 安全不变量**独立于 V**，不允许"进展收益抵消越权风险"。
 *
 * 本模块是纯契约与纯计算：不读盘、不派发、不联网。
 */
import { DomainError } from "../core/errors.js";
import { isKnownGoalPauseCondition } from "./goal-pause-condition-catalog.js";

/** 目标契约版本（字段变动即递增）。 */
export const GOAL_CONTRACT_SCHEMA_VERSION = 1;

/** 谁能合法修改目标。 */
export type GoalChangeProposer =
  | "source-publisher"
  | "authenticated-owner"
  | "model-proposal"
  | "tertiary-agent";

/** 资源上限（沿用既有预算；这里是目标级上限）。 */
export interface GoalResourceLimits {
  readonly maximumToolCalls: number | null;
  readonly maximumWallClockSeconds: number | null;
  readonly maximumCostUnits: number | null;
}

/** 完成谓词的可靠性：没有可靠谓词时只能记 `unknown`，不能给伪精确分值。 */
export type GoalCompletionPredicateKind =
  | "deterministic-check"
  | "independent-acceptance"
  | "unreliable";

export interface GoalRequirement {
  /** 稳定要求标识（来自原任务发布方，不由模型生成）。 */
  readonly requirementIdentifier: string;
  readonly description: string;
  /** 正权重；拆分不改总权重。 */
  readonly weight: number;
  /** 该要求是否有可靠完成谓词。 */
  readonly completionPredicateKind: GoalCompletionPredicateKind;
  /** 绑定的任务节点（可为空：尚未映射）。 */
  readonly taskNodeIdentifiers: readonly string[];
}

export interface GoalContract {
  readonly schemaVersion: typeof GOAL_CONTRACT_SCHEMA_VERSION;
  readonly goalIdentifier: string;
  readonly revision: number;
  /** 目标所有者（认证用户）。 */
  readonly ownerIdentifier: string;
  /** 原始要求引用（不可被模型改写）。 */
  readonly sourceRequestReference: string;
  readonly objectiveText: string;
  readonly scope: {
    readonly projectIdentifiers: readonly string[];
    readonly allowedToolNames: readonly string[] | null;
  };
  /** 不可违反项（安全不变量，独立于进展评分）。 */
  readonly nonViolableInvariants: readonly string[];
  readonly requirements: readonly GoalRequirement[];
  readonly resourceLimits: GoalResourceLimits;
  readonly deadlineIso: string | null;
  readonly pauseConditions: readonly string[];
  /** 目标版本变更是**新契约**，不是原地改字段。 */
  readonly supersedesRevision: number | null;
}

export type GoalContractValidation =
  | { readonly isValid: true }
  | { readonly isValid: false; readonly reasons: readonly string[] };

export function validateGoalContract(contract: GoalContract): GoalContractValidation {
  const reasons: string[] = [];
  if (contract.goalIdentifier.trim() === "") {
    reasons.push("缺少 goalIdentifier");
  }
  if (!Number.isInteger(contract.revision) || contract.revision < 1) {
    reasons.push("revision 必须是 ≥1 的整数");
  }
  if (contract.ownerIdentifier.trim() === "") {
    reasons.push("缺少 ownerIdentifier（目标必须绑定认证用户）");
  }
  if (contract.sourceRequestReference.trim() === "") {
    reasons.push("缺少原始要求引用");
  }
  /** R76（K6）：暂停条件必须是**可评估的有限枚举**，未知字符串一律拒绝。 */
  for (const pauseCondition of contract.pauseConditions) {
    if (!isKnownGoalPauseCondition(pauseCondition)) {
      reasons.push(`未知的暂停条件: ${pauseCondition}（必须是可评估的枚举值）`);
    }
  }
  if (contract.requirements.length === 0) {
    reasons.push("目标至少需要一条要求");
  }
  const seenIdentifiers = new Set<string>();
  for (const requirement of contract.requirements) {
    if (requirement.requirementIdentifier.trim() === "") {
      reasons.push("要求缺少标识");
      continue;
    }
    if (seenIdentifiers.has(requirement.requirementIdentifier)) {
      reasons.push(`要求标识重复: ${requirement.requirementIdentifier}`);
    }
    seenIdentifiers.add(requirement.requirementIdentifier);
    if (!Number.isFinite(requirement.weight) || requirement.weight <= 0) {
      reasons.push(`要求权重必须为正: ${requirement.requirementIdentifier}`);
    }
  }
  if (contract.deadlineIso !== null && Number.isNaN(Date.parse(contract.deadlineIso))) {
    reasons.push(`deadlineIso 非法: ${contract.deadlineIso}`);
  }
  return reasons.length === 0
    ? { isValid: true }
    : { isValid: false, reasons };
}

/**
 * 版本变更是否合法。
 *
 * 只有**原任务发布方**或**认证所有者**可以变更；模型与三级 Agent 的提案一律拒绝
 * （它们只能提出建议，由发布方决定）。
 */
export function assertGoalRevisionChangeAllowed(input: {
  readonly currentContract: GoalContract;
  readonly proposer: GoalChangeProposer;
  readonly nextRevision: number;
}): void {
  if (
    input.proposer !== "source-publisher" &&
    input.proposer !== "authenticated-owner"
  ) {
    throw new DomainError(
      "task-sequence-permission-denied",
      `目标变更必须来自原任务发布方或认证所有者，拒绝来自 ${input.proposer} 的修改。`,
    );
  }
  if (input.nextRevision !== input.currentContract.revision + 1) {
    throw new DomainError(
      "invalid-task-chain",
      `目标 revision 必须逐次 +1（当前 ${input.currentContract.revision}，收到 ${input.nextRevision}）。`,
    );
  }
}

/** 一条要求的证据状态。 */
export type GoalRequirementEvidence =
  | {
      readonly kind: "valid";
      /** 证据来源：确定性判据或独立验收（不回退到"模型说完成"）。 */
      readonly evidenceKind: "deterministic-check" | "independent-acceptance";
      readonly evidenceReference: string;
    }
  | { readonly kind: "unverified"; readonly reason: string }
  | { readonly kind: "invalidated"; readonly reason: string };

export interface GoalRequirementAssessment {
  readonly requirementIdentifier: string;
  readonly weight: number;
  readonly evidence: GoalRequirementEvidence;
  /** 该要求对 V 的贡献（valid=0；其余=weight）。 */
  readonly remainingContribution: number;
}

export type GoalPotentialResult =
  | {
      readonly status: "computed";
      /** 候选势函数 V = Σ weight × remainingRequirement。 */
      readonly potentialValue: number;
      readonly totalWeight: number;
      readonly assessmentCount: number;
      readonly assessments: readonly GoalRequirementAssessment[];
      /** V=0 只代表"已枚举要求都有有效证据"，不代表现实正确。 */
      readonly isAllRequirementsEvidenced: boolean;
    }
  | {
      readonly status: "unknown";
      readonly reason: string;
      readonly assessments: readonly GoalRequirementAssessment[];
    };

/**
 * 计算候选势函数 V。
 *
 * 关键约束：
 * - 只有 `kind:"valid"` 且证据来源是确定性判据/独立验收才把该项记 0；
 *   模型自述、"看起来完成"、工具调用次数、输出字数**都不降分**；
 * - 存在 `unreliable` 完成谓词的要求时，不返回伪精确分值，而是 `status:"unknown"`；
 * - 缺失某条要求的评估 ⇒ 视为未验证（不静默当作 0）。
 */
export function computeGoalPotential(input: {
  readonly contract: GoalContract;
  readonly assessments: readonly {
    readonly requirementIdentifier: string;
    readonly evidence: GoalRequirementEvidence;
  }[];
}): GoalPotentialResult {
  const assessmentByRequirement = new Map(
    input.assessments.map((assessment) => [
      assessment.requirementIdentifier,
      assessment.evidence,
    ]),
  );
  const assessments: GoalRequirementAssessment[] = input.contract.requirements.map(
    (requirement) => {
      const evidence =
        assessmentByRequirement.get(requirement.requirementIdentifier) ?? {
          kind: "unverified" as const,
          reason: "缺少评估记录（按未验证计，不静默降分）",
        };
      const isEvidenced =
        evidence.kind === "valid" &&
        (evidence.evidenceKind === "deterministic-check" ||
          evidence.evidenceKind === "independent-acceptance");
      return {
        requirementIdentifier: requirement.requirementIdentifier,
        weight: requirement.weight,
        evidence,
        remainingContribution: isEvidenced ? 0 : requirement.weight,
      };
    },
  );
  const unreliableRequirements = input.contract.requirements.filter(
    (requirement) => requirement.completionPredicateKind === "unreliable",
  );
  if (unreliableRequirements.length > 0) {
    return {
      status: "unknown",
      reason:
        "存在没有可靠完成谓词的要求，不能给出伪精确分值: " +
        unreliableRequirements
          .map((requirement) => requirement.requirementIdentifier)
          .join(", "),
      assessments,
    };
  }
  const potentialValue = assessments.reduce(
    (sum, assessment) => sum + assessment.remainingContribution,
    0,
  );
  const totalWeight = assessments.reduce(
    (sum, assessment) => sum + assessment.weight,
    0,
  );
  return {
    status: "computed",
    potentialValue,
    totalWeight,
    assessmentCount: assessments.length,
    assessments,
    isAllRequirementsEvidenced: potentialValue === 0,
  };
}

/**
 * 拆分任务时保持总权重不变（拆分不改变"还剩多少要证明"）。
 *
 * 允许把一条要求拆成多条，但子权重之和必须等于父权重（浮点用容差比较）。
 */
export function assertSubRequirementWeightsPreserveParent(input: {
  readonly parentWeight: number;
  readonly childWeights: readonly number[];
}): void {
  const childWeightSum = input.childWeights.reduce((sum, weight) => sum + weight, 0);
  const tolerance = 1e-9 * Math.max(1, Math.abs(input.parentWeight));
  if (Math.abs(childWeightSum - input.parentWeight) > tolerance) {
    throw new DomainError(
      "invalid-task-chain",
      `子要求权重之和 ${childWeightSum} 不等于父权重 ${input.parentWeight}（拆分不得改变总权重）。`,
    );
  }
}

/**
 * 目标模式激活判定（**唯一开关**）。
 *
 * 默认关闭在这里表达：三个条件必须同时为真（显式用户请求 + 认证用户 + 显式开启），
 * 且请求来源必须是 `user`。模型/三级 Agent/匿名调用一律不满足
 * （本函数不接受"模型说已开启"作为证据）。
 *
 * R5（2026-10-29）：删除 `GOAL_MODE_DEFAULT_ENABLED` 常量 —— 它此前**没有任何调用方**
 * （全仓仅定义处 1 次），留着只会让审计误以为"默认关闭已被代码保证"。
 * 现在"默认关闭"的唯一事实来源就是本函数；调用方**必须**用它，不能自行判断。
 */
export function resolveGoalModeActivation(input: {
  readonly isExplicitUserRequest: boolean;
  readonly isAuthenticatedUser: boolean;
  readonly isExplicitlyEnabled: boolean;
  readonly requestedBy: "user" | "model" | "tertiary-agent";
}): {
  readonly isActive: boolean;
  readonly reason: string;
} {
  if (input.requestedBy !== "user") {
    return {
      isActive: false,
      reason: `目标模式只能由认证用户开启（请求来源: ${input.requestedBy}）。`,
    };
  }
  if (!input.isAuthenticatedUser) {
    return { isActive: false, reason: "请求者不是认证用户。" };
  }
  if (!input.isExplicitUserRequest || !input.isExplicitlyEnabled) {
    return {
      isActive: false,
      reason: "目标模式默认关闭：需要用户显式请求并显式开启。",
    };
  }
  return { isActive: true, reason: "认证用户显式开启目标模式。" };
}

/**
 * 安全不变量检查：**独立于 V**。
 *
 * 返回"是否有违反"；调用方不得因为 V 下降而放过违反（本函数不接受 V 参数，结构上即隔离）。
 */
export function evaluateSafetyInvariants(input: {
  readonly contract: GoalContract;
  readonly violatedInvariantDescriptions: readonly string[];
}): {
  readonly isSatisfied: boolean;
  readonly violatedInvariants: readonly string[];
} {
  const knownInvariants = new Set(input.contract.nonViolableInvariants);
  const violatedInvariants = input.violatedInvariantDescriptions.filter(
    (description) => knownInvariants.has(description),
  );
  return {
    isSatisfied: violatedInvariants.length === 0,
    violatedInvariants,
  };
}

/**
 * R71（2026-10-30）：**契约变更校验（K3）**。
 *
 * 卡 01 要求：版本变更必须来自**原任务发布方或认证所有者**；模型/三级 Agent 的"建议"一律拒绝；
 * 变更不重置累计预算（由调用方保留计数）；变更不得降低判准（这里用"总权重不变"作为下限）。
 *
 * 纯函数：不读盘、不写盘、不派发。
 */
export function validateGoalContractChange(input: {
  readonly previousContract: GoalContract;
  readonly nextContract: GoalContract;
  readonly proposer: GoalChangeProposer;
}): { readonly isAllowed: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (input.proposer !== "source-publisher" && input.proposer !== "authenticated-owner") {
    reasons.push(`变更来源非法（${input.proposer}）：只有原发布方/认证所有者可以修改目标。`);
  }
  const validation = validateGoalContract(input.nextContract);
  if (!validation.isValid) {
    reasons.push(`新契约本身非法：${validation.reasons.join("；")}`);
  }
  if (input.nextContract.goalIdentifier !== input.previousContract.goalIdentifier) {
    reasons.push("变更不得更换 goalIdentifier（换了就是另一个目标）。");
  }
  if (input.nextContract.ownerIdentifier !== input.previousContract.ownerIdentifier) {
    reasons.push("变更不得更换 ownerIdentifier。");
  }
  if (
    input.nextContract.sourceRequestReference !==
    input.previousContract.sourceRequestReference
  ) {
    reasons.push("变更不得更换原始要求引用（模型不得改写来源）。");
  }
  if (input.nextContract.revision !== input.previousContract.revision + 1) {
    reasons.push(
      `revision 必须恰好 +1（当前 ${String(input.previousContract.revision)} → ${String(input.nextContract.revision)}）。`,
    );
  }
  if (input.nextContract.supersedesRevision !== input.previousContract.revision) {
    reasons.push(
      `supersedesRevision 必须等于被替代的 revision（${String(input.previousContract.revision)}）。`,
    );
  }
  const previousWeightTotal = input.previousContract.requirements.reduce(
    (total, requirement) => total + requirement.weight,
    0,
  );
  const nextWeightTotal = input.nextContract.requirements.reduce(
    (total, requirement) => total + requirement.weight,
    0,
  );
  if (Math.abs(previousWeightTotal - nextWeightTotal) > 1e-9) {
    reasons.push(
      `变更不得改变总权重（${String(previousWeightTotal)} → ${String(nextWeightTotal)}）：降权重等于降判准。`,
    );
  }
  return { isAllowed: reasons.length === 0, reasons };
}