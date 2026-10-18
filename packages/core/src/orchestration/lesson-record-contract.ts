/**
 * LESSON-01-01（2026-10-18 R13）：沟通经验记录的**契约层**（schema、事件时配置快照、个体归属与匹配）。
 *
 * 卡内依据（`docs/tasks/LESSON01_MODEL_ALIGNED_COMMUNICATION_MEMORY_TASK_CARD.md` §2–§4）：
 * - 记录必须含：所有者与来源（不可复用 `ownerAgentInstanceId`、记录 ID/revision、原任务及证据引用）、
 *   沟通关系（双方实际 `agentInstanceId`、层级、职责、方向、阶段）、**双方模型快照**（Provider、
 *   准确模型标识、版本、实际生效配置；**取事件发生时**而非写总结时）、任务情境、
 *   **内容三分离**（可观察事实 / 原因假设 / 下次行动建议）、范围、状态、有效性；
 * - 「缺失值**显式 unknown**，**未知不得当成精确匹配**」；配置指纹只用本地规范化非敏感快照，
 *   **不含凭据、令牌或私密端点**；
 * - 「Agent 可提交心得，但模型/身份/回执等**权威字段由本地补齐或验证**」；
 *   **无证据内容保留为未验证观察，默认不自动注入、不自动推广**；
 * - 「默认新记录是**任务专属**」；「职责/模型配置通用**不等于**所有任务都注入，必须仍与当前问题类型相关」；
 * - 主 Agent 只读：「**不向主 Agent 模型暴露写入工具**；其他 Agent 仅能在有效权限下写入自己的存档」。
 *
 * ## 边界
 * 纯判定：不写存档、不调模型、不注入上下文、不推广。
 */
import { createHash } from "node:crypto";

/** 内容范围（卡内"适用层次"，另加经审查的模型无关规范）。 */
export type LessonScopeKind =
  | "task"
  | "project"
  | "role-model-config"
  | "model-independent-norm";

/** 有效性状态（与"推广状态"**分离**）。 */
export type LessonValidityStatus =
  | "unverified-observation"
  | "verified"
  | "disproven"
  | "superseded"
  | "revoked";

/** 推广状态（与有效性分离）。 */
export type LessonPromotionStatus =
  | "not-eligible"
  | "candidate"
  | "under-review"
  | "approved-for-reuse"
  | "rejected";

/** 模型快照（**事件发生时**的实际配置；缺失显式 unknown）。 */
export interface LessonModelSnapshot {
  readonly providerIdentifier: string;
  readonly modelIdentifier: string;
  /** 版本无法获知时必须写 `unknown`（不得留空冒充已知）。 */
  readonly modelVersionIdentifier: string;
  /** 与工具行为相关的实际配置（如推理强度/温度/预算）；未知项写 `unknown`。 */
  readonly effectiveConfiguration: Readonly<Record<string, string>>;
}

/** 一条沟通经验记录（提交给本地校验的字段）。 */
export interface LessonRecordInput {
  readonly ownerAgentInstanceId: string;
  readonly recordIdentifier: string;
  readonly revision: number;
  readonly sourceTaskIdentifier: string;
  readonly sourceEvidenceReferences: ReadonlyArray<string>;
  readonly publisherAgentInstanceId: string;
  readonly recipientAgentInstanceId: string;
  readonly publisherRole: string;
  readonly recipientRole: string;
  readonly communicationDirection: "publisher-to-recipient" | "recipient-to-publisher";
  readonly communicationStage: string;
  readonly publisherModelSnapshot: LessonModelSnapshot;
  readonly recipientModelSnapshot: LessonModelSnapshot;
  /** 快照来源：必须**取自运行时**（写总结时重建不算）。 */
  readonly snapshotSource: "runtime" | "reconstructed";
  readonly taskContextDescription: string;
  /** —— 内容三分离（不得混为确定事实）—— */
  readonly observableFacts: ReadonlyArray<string>;
  readonly causeHypotheses: ReadonlyArray<string>;
  readonly nextActionAdvice: ReadonlyArray<string>;
  readonly scopeKind: LessonScopeKind;
  /** 默认任务专属；调用方可显式给别的范围，但需审查（由 promotion 流程保证）。 */
  readonly validityStatus: LessonValidityStatus;
  readonly promotionStatus: LessonPromotionStatus;
  readonly createdAtIso: string;
  readonly verifiedAtIso: string | null;
  readonly policyVersion: string;
  /** 敏感字段（凭据/令牌/私密端点）**不得**进入快照；出现即拒。 */
  readonly sensitiveFieldNames?: ReadonlyArray<string>;
}

/** 校验结论。 */
export type LessonRecordValidation =
  | { readonly kind: "accepted"; readonly record: LessonRecordInput; readonly fingerprint: string }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "missing-required-field"
        | "snapshot-not-runtime"
        | "unclear-unknown"
        | "facts-hypotheses-mixed"
        | "facts-without-evidence"
        | "sensitive-config-included"
        | "invalid-revision";
      readonly reason: string;
    };

/** 主 Agent 模型的沟通经验写入能力：**无**（卡内硬约束）。 */
export const MAIN_AGENT_LESSON_WRITE_CAPABILITY = "none" as const;

/** 默认范围：任务专属。 */
export const LESSON_DEFAULT_SCOPE_KIND: LessonScopeKind = "task";

const SENSITIVE_FIELD_PATTERN = /(api[-_]?key|token|secret|password|credential|private[-_]?key)/i;

function isNonBlank(value: string): boolean {
  return value.trim() !== "";
}

function isSnapshotWellFormed(snapshot: LessonModelSnapshot): boolean {
  if (!isNonBlank(snapshot.providerIdentifier) || !isNonBlank(snapshot.modelIdentifier)) {
    return false;
  }
  // 版本未知必须显式写 `unknown`，不得留空
  if (snapshot.modelVersionIdentifier.trim() === "") return false;
  return Object.entries(snapshot.effectiveConfiguration).every(
    ([key, value]) => isNonBlank(key) && value.trim() !== "",
  );
}

/** 校验一条经验记录（fail-closed）。 */
export function validateLessonRecord(record: LessonRecordInput): LessonRecordValidation {
  if (
    !isNonBlank(record.ownerAgentInstanceId) ||
    !isNonBlank(record.recordIdentifier) ||
    !isNonBlank(record.sourceTaskIdentifier) ||
    !isNonBlank(record.publisherAgentInstanceId) ||
    !isNonBlank(record.recipientAgentInstanceId) ||
    !isNonBlank(record.publisherRole) ||
    !isNonBlank(record.recipientRole) ||
    !isNonBlank(record.communicationStage) ||
    !isNonBlank(record.taskContextDescription) ||
    !isNonBlank(record.policyVersion)
  ) {
    return {
      kind: "rejected",
      reasonCode: "missing-required-field",
      reason: "缺少身份/来源/角色/阶段/任务情境/策略版本等必填字段。",
    };
  }
  if (!Number.isInteger(record.revision) || record.revision < 1) {
    return { kind: "rejected", reasonCode: "invalid-revision", reason: "revision 必须是正整数。" };
  }
  if (record.snapshotSource !== "runtime") {
    return {
      kind: "rejected",
      reasonCode: "snapshot-not-runtime",
      reason: "模型配置快照必须取自**事件发生时**的运行时；写总结时重建的不算。",
    };
  }
  if (
    !isSnapshotWellFormed(record.publisherModelSnapshot) ||
    !isSnapshotWellFormed(record.recipientModelSnapshot)
  ) {
    return {
      kind: "rejected",
      reasonCode: "unclear-unknown",
      reason: "双方模型快照不完整：缺失值必须显式写 unknown，不得留空。",
    };
  }
  const sensitiveNames = [
    ...(record.sensitiveFieldNames ?? []),
    ...Object.keys(record.publisherModelSnapshot.effectiveConfiguration),
    ...Object.keys(record.recipientModelSnapshot.effectiveConfiguration),
  ];
  if (sensitiveNames.some((name) => SENSITIVE_FIELD_PATTERN.test(name))) {
    return {
      kind: "rejected",
      reasonCode: "sensitive-config-included",
      reason: "配置快照含凭据/令牌/私密端点类字段：指纹只能来自非敏感快照。",
    };
  }
  if (record.observableFacts.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "missing-required-field",
      reason: "至少需要一条可观察事实：无证据内容只能是未验证观察且需显式标注。",
    };
  }
  if (record.observableFacts.some((fact) => !isNonBlank(fact))) {
    return { kind: "rejected", reasonCode: "missing-required-field", reason: "事实条目不得为空。" };
  }
  if (
    record.sourceEvidenceReferences.length === 0 ||
    record.sourceEvidenceReferences.some((reference) => !isNonBlank(reference))
  ) {
    return {
      kind: "rejected",
      reasonCode: "facts-without-evidence",
      reason: "事实必须带证据引用（原任务/消息/工具回执）。",
    };
  }
  // 事实与假设不得混写：同一条目既出现在事实又出现在假设 ⇒ 视为混用
  const hypothesisAsFact = record.causeHypotheses.find((hypothesis) =>
    record.observableFacts.includes(hypothesis),
  );
  if (hypothesisAsFact !== undefined) {
    return {
      kind: "rejected",
      reasonCode: "facts-hypotheses-mixed",
      reason: "同一条目同时被当作事实与假设：必须区分确定事实与原因假设。",
    };
  }
  if (record.validityStatus === "unverified-observation" && record.causeHypotheses.length === 0) {
    // 允许，但未验证观察默认不注入（由 isLessonAutoInjectible 判定）
  }

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        record.ownerAgentInstanceId,
        record.recordIdentifier,
        record.revision,
        record.publisherModelSnapshot,
        record.recipientModelSnapshot,
        record.observableFacts,
        record.causeHypotheses,
        record.nextActionAdvice,
        record.scopeKind,
        record.validityStatus,
      ]),
    )
    .digest("hex");

  return { kind: "accepted", record, fingerprint };
}

/**
 * 未验证观察**默认不自动注入**（卡内§2）；只有已核验的才允许自动注入。
 * 推广状态与有效性分离：即便 `approved-for-reuse`，若有效性为 `disproven`/`revoked` 也不注入。
 */
export function isLessonAutoInjectible(record: LessonRecordInput): boolean {
  if (record.validityStatus !== "verified") return false;
  return record.promotionStatus !== "rejected";
}

/** 写入判定结论。 */
export type LessonWriteDecision =
  | { readonly kind: "allowed"; readonly reason: string }
  | {
      readonly kind: "denied";
      readonly reasonCode:
        | "main-agent-write-forbidden"
        | "cross-individual-write"
        | "unverified-promotion";
      readonly reason: string;
    };

/**
 * 判定某写入方能否把经验写进某个体存档。
 *
 * - **主 Agent 模型**：永远不能写（只读角色）；
 * - 模型 Agent：只能写**自己**的存档（`writerAgentInstanceId === ownerAgentInstanceId`）；
 * - 本地控制面（`isLocalControlPlane`）：可代表主 Agent 存档（权威字段由它补齐）；
 * - 未核验的观察**不得**同时登记为推广批准（自提自批）。
 */
export function evaluateLessonWrite(input: {
  readonly writerAgentInstanceId: string | null;
  readonly ownerAgentInstanceId: string;
  readonly isLocalControlPlane: boolean;
  readonly isMainAgentModel: boolean;
  readonly validityStatus: LessonValidityStatus;
  readonly promotionStatus: LessonPromotionStatus;
}): LessonWriteDecision {
  if (input.isMainAgentModel) {
    return {
      kind: "denied",
      reasonCode: "main-agent-write-forbidden",
      reason: "主 Agent 模型不暴露写入工具：沟通经验由本地控制面存档。",
    };
  }
  if (!input.isLocalControlPlane && input.writerAgentInstanceId !== input.ownerAgentInstanceId) {
    return {
      kind: "denied",
      reasonCode: "cross-individual-write",
      reason: "只能写入自己的存档：跨个体写入必须由本地控制面在授权下执行。",
    };
  }
  if (
    input.validityStatus === "unverified-observation" &&
    input.promotionStatus === "approved-for-reuse"
  ) {
    return {
      kind: "denied",
      reasonCode: "unverified-promotion",
      reason: "未经核验的观察不得直接升级为可推广条目（不能自提自批）。",
    };
  }
  return { kind: "allowed", reason: "写入方与归属一致（或由本地控制面代理），且状态合法。" };
}

/** 匹配结论。 */
export interface LessonApplicabilityDecision {
  readonly isApplicable: boolean;
  /** `exact` = 全部维度严格匹配；`reference-only` = 相近/未知，只能作为参考且需显示差异。 */
  readonly matchQuality: "exact" | "reference-only";
  readonly differences: ReadonlyArray<string>;
  readonly reason: string;
}

/**
 * 判定一条经验是否适用于当前任务（卡内§4）。
 *
 * 默认**严格匹配**：沟通方向、双方职责、双方模型/版本与实际配置、任务类型与触发条件。
 * - **未知不得当成精确匹配**（`unknown` 只会得到 `reference-only` 并列出差异）；
 * - 模型无关规范只在**用户确认**后才可跨模型自动使用；
 * - 实例 ID 不参与"必须相等"的判断（只用于追溯/访问控制）。
 */
export function isLessonApplicableToTask(input: {
  readonly record: LessonRecordInput;
  readonly current: {
    readonly communicationDirection: "publisher-to-recipient" | "recipient-to-publisher";
    readonly publisherRole: string;
    readonly recipientRole: string;
    readonly publisherModelSnapshot: LessonModelSnapshot;
    readonly recipientModelSnapshot: LessonModelSnapshot;
    readonly taskType: string;
    readonly triggerCondition: string;
  };
  readonly isModelIndependentNormConfirmedByUser?: boolean;
}): LessonApplicabilityDecision {
  if (input.record.scopeKind === "model-independent-norm") {
    if (input.isModelIndependentNormConfirmedByUser !== true) {
      return {
        isApplicable: false,
        matchQuality: "reference-only",
        differences: ["model-independent-norm-not-confirmed"],
        reason: "模型无关规范需用户确认后才能跨模型自动使用。",
      };
    }
    return {
      isApplicable: true,
      matchQuality: "exact",
      differences: [],
      reason: "用户已确认该模型无关规范。",
    };
  }

  const differences: string[] = [];
  if (input.record.communicationDirection !== input.current.communicationDirection) {
    differences.push("communication-direction");
  }
  if (input.record.publisherRole !== input.current.publisherRole) differences.push("publisher-role");
  if (input.record.recipientRole !== input.current.recipientRole) differences.push("recipient-role");
  if (
    input.record.publisherModelSnapshot.providerIdentifier !==
      input.current.publisherModelSnapshot.providerIdentifier ||
    input.record.publisherModelSnapshot.modelIdentifier !==
      input.current.publisherModelSnapshot.modelIdentifier
  ) {
    differences.push("publisher-model");
  }
  if (
    input.record.recipientModelSnapshot.providerIdentifier !==
      input.current.recipientModelSnapshot.providerIdentifier ||
    input.record.recipientModelSnapshot.modelIdentifier !==
      input.current.recipientModelSnapshot.modelIdentifier
  ) {
    differences.push("recipient-model");
  }
  const hasUnknownVersion =
    input.record.publisherModelSnapshot.modelVersionIdentifier === "unknown" ||
    input.record.recipientModelSnapshot.modelVersionIdentifier === "unknown" ||
    input.current.publisherModelSnapshot.modelVersionIdentifier === "unknown" ||
    input.current.recipientModelSnapshot.modelVersionIdentifier === "unknown";
  if (hasUnknownVersion) differences.push("model-version-unknown");
  if (!input.record.taskContextDescription.includes(input.current.taskType)) {
    differences.push("task-type");
  }

  if (differences.length === 0) {
    return {
      isApplicable: true,
      matchQuality: "exact",
      differences,
      reason: "方向/职责/模型/任务类型严格匹配。",
    };
  }
  // 只有"未知版本"这一条差异时，仍只能作为**参考**（不能伪装精确匹配）
  const isOnlyUnknownVersion = differences.length === 1 && differences[0] === "model-version-unknown";
  return {
    isApplicable: isOnlyUnknownVersion,
    matchQuality: "reference-only",
    differences,
    reason: isOnlyUnknownVersion
      ? "模型版本未知：只能作为参考返回并显示差异，不伪装精确匹配。"
      : "存在维度差异：不作为适用经验注入。",
  };
}
