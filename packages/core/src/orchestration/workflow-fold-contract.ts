/**
 * FOLD-01-01（EXP-01，2026-10-18 R9）：**等价折叠的复用契约、候选与版本/权限模型**。
 *
 * 卡内依据（`docs/tasks/EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS.md` §2）：
 * - 「所谓等价是滿足**明确前置条件**下的**行为契约**，**不是相似文本或模型口头判断**」；
 * - 候选必须记录：原始工作流引用、步骤偏序/依赖、输入输出、固定步骤、可变参数、
 *   前置条件、失败恢复、验收方式、**不适用边界**；
 * - 「权限按**展开后的每个实际步骤**执行前检查，不能用外层一次批准掩盖内部安装、外部写入或备份删除」；
 * - 「参数必须包含**影响副作用的内容/目标**，防止模板把不同写入内容映射成同一授权或幂等身份；
 *   **不折叠用户授权、实际结果或验收回执**。**只复用方法，不复用上次操作许可**」；
 * - 「升级不静默改变在途实例，执行记录绑定版本；出现回归可以**停用新版本**，
 *   回退前**确认没有未知副作用**，**不自动重跑**旧工作流」。
 *
 * ## 边界
 * 纯判定：不执行工作流、不注册工具、不写盘、不调模型。只回答"能否作为可复用候选/登记/回退"。
 */
import { createHash } from "node:crypto";

/** 可变参数的副作用类别（卡内要求：影响副作用的内容/目标必须被声明为参数）。 */
export type FoldParameterEffectKind = "content" | "target" | "benign";

/** 一个可变参数。 */
export interface FoldParameter {
  readonly parameterName: string;
  readonly effectKind: FoldParameterEffectKind;
  /** 参数 schema 片段（JSON Schema 子集，字符串形式；缺省即不接受）。 */
  readonly schemaJson: string;
}

/** 一个步骤（含偏序依赖）。 */
export interface FoldStep {
  readonly stepIdentifier: string;
  /** 依赖的前置步骤（**偏序**，不是数组顺序）。 */
  readonly dependsOnStepIdentifiers: ReadonlyArray<string>;
  readonly toolName: string;
  /** 该步骤是否是**固定**步骤（不随参数变化）。 */
  readonly isFixed: boolean;
}

/** 折叠候选（提交给控制面判定的完整记录）。 */
export interface FoldCandidateInput {
  readonly originalWorkflowReference: string;
  readonly steps: ReadonlyArray<FoldStep>;
  readonly inputsDescription: string;
  readonly outputsDescription: string;
  readonly parameters: ReadonlyArray<FoldParameter>;
  /** 等价成立所需的**明确前置条件**（不得为空）。 */
  readonly preconditions: ReadonlyArray<string>;
  readonly failureRecoveryDescription: string;
  readonly acceptanceMethodDescription: string;
  /** **不适用边界**（何时不得复用）。 */
  readonly nonApplicableBoundaries: ReadonlyArray<string>;
  /** 候选是否试图把下列"不可折叠项"也折进去（显式声明，便于拒绝）。 */
  readonly foldedNonFoldableItems?: ReadonlyArray<string>;
}

/**
 * **不可折叠项**（冻结，卡内逐条点名）。
 *
 * 这些是"每次都必须重新产生"的事实/授权，不是方法：把它们折进模板等于
 * 复用上次许可或伪装上次结果。
 */
export const NON_FOLDABLE_ITEMS: ReadonlyArray<string> = [
  "user-authorization",
  "operation-result",
  "acceptance-receipt",
  "permission-decision",
  "one-time-nonce",
  "approval-fingerprint",
];

/** 折叠候选校验结论。 */
export type FoldCandidateAssessment =
  | { readonly kind: "accepted"; readonly candidate: FoldCandidateInput; readonly fingerprint: string }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "missing-required-field"
        | "no-preconditions"
        | "no-non-applicable-boundary"
        | "ambiguous-equivalence"
        | "folds-non-foldable-item"
        | "unparameterized-side-effect"
        | "no-steps";
      readonly reason: string;
    };

function isNonBlank(value: string): boolean {
  return value.trim() !== "";
}

/** 步骤偏序是否合法（依赖存在且无环）。 */
export function isFoldStepDependencyOrderValid(steps: ReadonlyArray<FoldStep>): boolean {
  const identifiers = new Set(steps.map((step) => step.stepIdentifier));
  for (const step of steps) {
    for (const dependency of step.dependsOnStepIdentifiers) {
      if (!identifiers.has(dependency) || dependency === step.stepIdentifier) return false;
    }
  }
  // 环检测（DFS 三色）
  const visitState = new Map<string, "visiting" | "visited">();
  const byIdentifier = new Map(steps.map((step) => [step.stepIdentifier, step]));
  const visit = (stepIdentifier: string): boolean => {
    const state = visitState.get(stepIdentifier);
    if (state === "visited") return true;
    if (state === "visiting") return false;
    visitState.set(stepIdentifier, "visiting");
    const step = byIdentifier.get(stepIdentifier);
    for (const dependency of step?.dependsOnStepIdentifiers ?? []) {
      if (!visit(dependency)) return false;
    }
    visitState.set(stepIdentifier, "visited");
    return true;
  };
  for (const step of steps) {
    if (!visit(step.stepIdentifier)) return false;
  }
  return true;
}

/**
 * 校验一个折叠候选。
 *
 * 拒绝条件（全部 fail-closed）：
 * 1. 缺少必需字段（原始工作流引用/输入输出/失败恢复/验收方式）；
 * 2. 没有前置条件 ⇒ "等价"没有成立条件（**拒绝以相似文本冒充等价**）；
 * 3. 没有不适用边界 ⇒ 边界未冻结；
 * 4. 没有任何步骤，或偏序非法（依赖不存在/自环/成环）；
 * 5. 试图把**不可折叠项**折进去；
 * 6. 步骤里出现"影响副作用"的可变参数却没有声明（无法保证同一授权/幂等身份只对应同一内容/目标）。
 */
export function assessFoldCandidate(candidate: FoldCandidateInput): FoldCandidateAssessment {
  if (!isNonBlank(candidate.originalWorkflowReference)) {
    return { kind: "rejected", reasonCode: "missing-required-field", reason: "缺少原始工作流引用。" };
  }
  if (
    !isNonBlank(candidate.inputsDescription) ||
    !isNonBlank(candidate.outputsDescription) ||
    !isNonBlank(candidate.failureRecoveryDescription) ||
    !isNonBlank(candidate.acceptanceMethodDescription)
  ) {
    return {
      kind: "rejected",
      reasonCode: "missing-required-field",
      reason: "缺少输入/输出/失败恢复/验收方式之一：候选不完整。",
    };
  }
  if (candidate.preconditions.length === 0 || candidate.preconditions.some((item) => !isNonBlank(item))) {
    return {
      kind: "rejected",
      reasonCode: "no-preconditions",
      reason: "缺少明确前置条件：不得用相似文本或口头判断冒充等价。",
    };
  }
  if (
    candidate.nonApplicableBoundaries.length === 0 ||
    candidate.nonApplicableBoundaries.some((item) => !isNonBlank(item))
  ) {
    return {
      kind: "rejected",
      reasonCode: "no-non-applicable-boundary",
      reason: "缺少不适用边界：等价范围未冻结。",
    };
  }
  if (candidate.steps.length === 0) {
    return { kind: "rejected", reasonCode: "no-steps", reason: "候选没有任何步骤。" };
  }
  if (!isFoldStepDependencyOrderValid(candidate.steps)) {
    return {
      kind: "rejected",
      reasonCode: "ambiguous-equivalence",
      reason: "步骤偏序非法（依赖不存在/自环/成环）：无法确定执行顺序。",
    };
  }
  const foldedItems = candidate.foldedNonFoldableItems ?? [];
  const offendingItem = foldedItems.find((item) => NON_FOLDABLE_ITEMS.includes(item));
  if (offendingItem !== undefined) {
    return {
      kind: "rejected",
      reasonCode: "folds-non-foldable-item",
      reason: `不可折叠项被折进模板：${offendingItem}（只复用方法，不复用许可/结果/回执）。`,
    };
  }
  // 副作用参数：只要候选声明了 content/target 之外的"写入类"参数，就必须显式声明
  const hasUndeclaredSideEffectParameter = candidate.parameters.some(
    (parameter) =>
      (parameter.effectKind === "content" || parameter.effectKind === "target") &&
      (!isNonBlank(parameter.parameterName) || !isNonBlank(parameter.schemaJson)),
  );
  if (hasUndeclaredSideEffectParameter) {
    return {
      kind: "rejected",
      reasonCode: "unparameterized-side-effect",
      reason: "影响副作用的内容/目标参数缺少名称或 schema：无法保证授权与幂等身份一一对应。",
    };
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        candidate.originalWorkflowReference,
        candidate.steps.map((step) => [
          step.stepIdentifier,
          step.toolName,
          [...step.dependsOnStepIdentifiers].sort(),
          step.isFixed,
        ]),
        candidate.parameters.map((parameter) => [
          parameter.parameterName,
          parameter.effectKind,
          parameter.schemaJson,
        ]),
        candidate.preconditions,
        candidate.nonApplicableBoundaries,
      ]),
    )
    .digest("hex");

  return { kind: "accepted", candidate, fingerprint };
}

/** 可复用工具的版本化登记（卡内：版本化名称/参数 schema/来源/完整公开用法）。 */
export interface ReusableToolRegistrationV1 {
  readonly schemaVersion: 1;
  readonly toolIdentifier: string;
  readonly version: number;
  readonly parameterSchemaJson: string;
  readonly sourceIdentifier: string;
  readonly fullPublicUsage: string;
  /** 展开后每个实际步骤仍须执行前检查（外层批准不能掩盖内部操作）。 */
  readonly requiresPerStepAuthorization: true;
  /** 只复用方法，**不复用**上次操作许可。 */
  readonly reusesPreviousAuthorization: false;
  readonly registrationFingerprint: string;
}

export type ReusableToolRegistrationOutcome =
  | { readonly kind: "registered"; readonly registration: ReusableToolRegistrationV1 }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * 生成版本化登记。
 *
 * 拒绝：标识/来源/公开用法/参数 schema 缺失、版本不是正整数、候选未通过折叠校验。
 */
export function buildReusableToolRegistration(input: {
  readonly toolIdentifier: string;
  readonly version: number;
  readonly parameterSchemaJson: string;
  readonly sourceIdentifier: string;
  readonly fullPublicUsage: string;
  readonly foldAssessment: FoldCandidateAssessment;
}): ReusableToolRegistrationOutcome {
  if (input.foldAssessment.kind !== "accepted") {
    return { kind: "rejected", reason: `候选未通过折叠校验：${input.foldAssessment.reason}` };
  }
  if (!isNonBlank(input.toolIdentifier) || !isNonBlank(input.sourceIdentifier)) {
    return { kind: "rejected", reason: "缺少工具标识或来源。" };
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    return { kind: "rejected", reason: "版本必须是正整数。" };
  }
  if (!isNonBlank(input.parameterSchemaJson) || !isNonBlank(input.fullPublicUsage)) {
    return { kind: "rejected", reason: "缺少参数 schema 或完整公开用法。" };
  }

  const registrationFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        input.toolIdentifier,
        input.version,
        input.parameterSchemaJson,
        input.sourceIdentifier,
        input.fullPublicUsage,
      ]),
    )
    .digest("hex");

  return {
    kind: "registered",
    registration: {
      schemaVersion: 1,
      toolIdentifier: input.toolIdentifier,
      version: input.version,
      parameterSchemaJson: input.parameterSchemaJson,
      sourceIdentifier: input.sourceIdentifier,
      fullPublicUsage: input.fullPublicUsage,
      requiresPerStepAuthorization: true,
      reusesPreviousAuthorization: false,
      registrationFingerprint,
    },
  };
}

/**
 * 版本回退判定。
 *
 * 卡内：「出现回归可以停用新版本，**回退前确认没有未知副作用**，**不自动重跑旧工作流**」。
 */
export function evaluateReusableToolRollback(input: {
  readonly currentVersion: number;
  readonly targetVersion: number;
  readonly hasUnknownSideEffects: boolean;
}): {
  readonly isAllowed: boolean;
  readonly reasonCode: "allowed" | "unknown-side-effects" | "invalid-version";
  readonly doesAutoReplayOldWorkflow: false;
  readonly reason: string;
} {
  if (
    !Number.isInteger(input.currentVersion) ||
    !Number.isInteger(input.targetVersion) ||
    input.targetVersion < 1 ||
    input.targetVersion >= input.currentVersion
  ) {
    return {
      isAllowed: false,
      reasonCode: "invalid-version",
      doesAutoReplayOldWorkflow: false,
      reason: "目标版本必须是小于当前版本的正整数。",
    };
  }
  if (input.hasUnknownSideEffects) {
    return {
      isAllowed: false,
      reasonCode: "unknown-side-effects",
      doesAutoReplayOldWorkflow: false,
      reason: "存在未知副作用：先对账再回退，不自动重跑旧工作流。",
    };
  }
  return {
    isAllowed: true,
    reasonCode: "allowed",
    doesAutoReplayOldWorkflow: false,
    reason: "无未知副作用，允许停用新版本并回退；旧工作流不会被自动重跑。",
  };
}
