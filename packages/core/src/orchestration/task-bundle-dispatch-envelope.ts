/**
 * ALIGN-03-02（2026-10-28）：**任务包派发信封**（工具权限上限 / 项目边界 / 原始要求 /
 * 完成条件 / 选择性附件 / 工具说明引用）。
 *
 * 卡内要求：持续调度的任务包必须携带这六项；**子权限与上级有效权限求交**；
 * 工具首次说明/后续回访**复用既有协议**，不能每次重发完整工具库，
 * 也不能在缺用法时让模型猜。
 *
 * 三条硬约束：
 * 1. **只求交、不放大**：`allowedToolNames = 请求 ∩ 上级有效权限`；
 *    请求里超出上级的项**不会**进入信包（在 `deniedToolNames` 里如实返回，供上层报告）。
 * 2. **不携带工具库**：信包里只允许 `toolDocumentationReference`
 *    （`toolGroupIdentifier` + `toolGroupRevision`），由既有
 *    `ToolDocumentationRecallInjector` 决定 initial-full / reminder / delta；
 *    出现 `toolDescriptors`/`availableTools` 等字段直接拒绝。
 * 3. **六项缺一不可**：权限上限、项目边界、原始要求、完成条件、工具说明引用必须非空；
 *    附件必须是**显式选择**（带内容哈希），不允许"整个上下文一起带"。
 */
import { DomainError } from "../core/errors.js";

/** 允许出现在信包里的字段（严格白名单）。 */
const ALLOWED_ENVELOPE_FIELDS = [
  "bundleIdentifier",
  "toolPermissionCeiling",
  "projectBoundary",
  "originalRequirements",
  "completionConditions",
  "selectedAttachments",
  "toolDocumentationReference",
] as const;

/** 一旦出现就说明"想重发完整工具库"的字段（拒绝，不静默忽略）。 */
const FORBIDDEN_TOOL_LIBRARY_FIELDS = [
  "toolDescriptors",
  "availableTools",
  "toolLibrary",
  "fullDocumentation",
  "toolSchemas",
] as const;

export interface TaskBundleToolPermissionCeiling {
  readonly requestedToolNames: readonly string[];
}

export interface TaskBundleProjectBoundary {
  readonly projectIdentifier: string;
  readonly workspaceRootPath: string;
  /** 只读边界（子任务不得借任务包扩写权限）。 */
  readonly isReadOnly: boolean;
}

export interface TaskBundleOriginalRequirements {
  /** 用户原始任务引用（harness 生成，不得由模型编造）。 */
  readonly userTaskReference: string;
  readonly instructionText: string;
}

export interface TaskBundleCompletionConditions {
  readonly acceptanceCriteria: string;
  readonly requiredArtifactIdentifiers: readonly string[];
}

export interface TaskBundleSelectedAttachment {
  readonly attachmentIdentifier: string;
  readonly contentHash: string;
}

export interface TaskBundleToolDocumentationReference {
  readonly toolGroupIdentifier: string;
  readonly toolGroupRevision: number;
}

export interface TaskBundleDispatchEnvelope {
  readonly bundleIdentifier: string;
  /** **求交后**的工具上限（不含上级未授予的工具）。 */
  readonly allowedToolNames: readonly string[];
  /** 请求里被上级权限挡下的工具（如实记录，供上层报告；不进入执行）。 */
  readonly deniedToolNames: readonly string[];
  readonly projectBoundary: TaskBundleProjectBoundary;
  readonly originalRequirements: TaskBundleOriginalRequirements;
  readonly completionConditions: TaskBundleCompletionConditions;
  readonly selectedAttachments: readonly TaskBundleSelectedAttachment[];
  readonly toolDocumentationReference: TaskBundleToolDocumentationReference;
}

export interface BuildTaskBundleDispatchEnvelopeInput {
  /** 候选信包（可能来自模型规划，按不可信处理）。 */
  readonly payload: unknown;
  /** 上级（次级）当前**有效**工具权限集合。 */
  readonly parentEffectiveToolNames: readonly string[];
}

/**
 * 解析并构造信包：严格白名单 → 校验六项 → 与上级权限**求交**。
 *
 * 超出上级权限的请求不报错（求交语义），但会在 `deniedToolNames` 里列出；
 * 因此上层能区分"本来就只给了这些"与"申请被削"。
 */
export function buildTaskBundleDispatchEnvelope(
  input: BuildTaskBundleDispatchEnvelopeInput,
): TaskBundleDispatchEnvelope {
  if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) {
    throw new DomainError("task-bundle-invalid", "任务包信包必须是 JSON 对象。");
  }
  const record = input.payload as Record<string, unknown>;
  const forbiddenFields = FORBIDDEN_TOOL_LIBRARY_FIELDS.filter(
    (fieldName) => record[fieldName] !== undefined,
  );
  if (forbiddenFields.length > 0) {
    throw new DomainError(
      "task-bundle-invalid",
      `任务包不得重发完整工具库（应由工具说明协议按 revision 注入）: ${forbiddenFields.join(", ")}`,
    );
  }
  const unknownFields = Object.keys(record).filter(
    (fieldName) => !(ALLOWED_ENVELOPE_FIELDS as readonly string[]).includes(fieldName),
  );
  if (unknownFields.length > 0) {
    throw new DomainError(
      "task-bundle-invalid",
      `任务包信包含有不支持的字段（不得静默忽略）: ${unknownFields.join(", ")}`,
    );
  }

  const permissionRecord = readRequiredObject(record, "toolPermissionCeiling");
  const requestedToolNames = readStringArray(permissionRecord, "requestedToolNames");
  const parentEffectiveToolNames = new Set(input.parentEffectiveToolNames);
  const allowedToolNames = [
    ...new Set(requestedToolNames.filter((toolName) => parentEffectiveToolNames.has(toolName))),
  ];
  const deniedToolNames = [
    ...new Set(requestedToolNames.filter((toolName) => !parentEffectiveToolNames.has(toolName))),
  ];
  if (allowedToolNames.length === 0) {
    throw new DomainError(
      "task-bundle-invalid",
      "求交后没有任何可用工具：任务包无法执行（拒绝发出空权限信包）。",
    );
  }

  const projectBoundaryRecord = readRequiredObject(record, "projectBoundary");
  const projectBoundary: TaskBundleProjectBoundary = {
    projectIdentifier: readRequiredString(projectBoundaryRecord, "projectIdentifier"),
    workspaceRootPath: readRequiredString(projectBoundaryRecord, "workspaceRootPath"),
    isReadOnly: projectBoundaryRecord["isReadOnly"] === true,
  };

  const requirementsRecord = readRequiredObject(record, "originalRequirements");
  const originalRequirements: TaskBundleOriginalRequirements = {
    userTaskReference: readRequiredString(requirementsRecord, "userTaskReference"),
    instructionText: readRequiredString(requirementsRecord, "instructionText"),
  };

  const conditionsRecord = readRequiredObject(record, "completionConditions");
  const completionConditions: TaskBundleCompletionConditions = {
    acceptanceCriteria: readRequiredString(conditionsRecord, "acceptanceCriteria"),
    requiredArtifactIdentifiers: readStringArray(
      conditionsRecord,
      "requiredArtifactIdentifiers",
    ),
  };

  const attachmentsValue = record["selectedAttachments"];
  if (attachmentsValue !== undefined && !Array.isArray(attachmentsValue)) {
    throw new DomainError("task-bundle-invalid", "selectedAttachments 必须是数组。");
  }
  const selectedAttachments: TaskBundleSelectedAttachment[] = (
    (attachmentsValue as unknown[] | undefined) ?? []
  ).map((attachmentValue) => {
    if (
      typeof attachmentValue !== "object" ||
      attachmentValue === null ||
      Array.isArray(attachmentValue)
    ) {
      throw new DomainError("task-bundle-invalid", "附件引用必须是对象。");
    }
    const attachmentRecord = attachmentValue as Record<string, unknown>;
    return {
      attachmentIdentifier: readRequiredString(attachmentRecord, "attachmentIdentifier"),
      contentHash: readRequiredString(attachmentRecord, "contentHash"),
    };
  });

  const documentationRecord = readRequiredObject(record, "toolDocumentationReference");
  const toolGroupRevisionValue = documentationRecord["toolGroupRevision"];
  if (
    typeof toolGroupRevisionValue !== "number" ||
    !Number.isInteger(toolGroupRevisionValue) ||
    toolGroupRevisionValue < 1
  ) {
    throw new DomainError(
      "task-bundle-invalid",
      "toolDocumentationReference.toolGroupRevision 必须是 ≥1 的整数。",
    );
  }

  return {
    bundleIdentifier: readRequiredString(record, "bundleIdentifier"),
    allowedToolNames,
    deniedToolNames,
    projectBoundary,
    originalRequirements,
    completionConditions,
    selectedAttachments,
    toolDocumentationReference: {
      toolGroupIdentifier: readRequiredString(documentationRecord, "toolGroupIdentifier"),
      toolGroupRevision: toolGroupRevisionValue,
    },
  };
}

/** 纯求交（供"先算权限、后组信包"的调用方复用）。 */
export function intersectToolPermissionCeiling(input: {
  readonly parentEffectiveToolNames: readonly string[];
  readonly requestedToolNames: readonly string[];
}): { allowedToolNames: string[]; deniedToolNames: string[] } {
  const parentEffectiveToolNames = new Set(input.parentEffectiveToolNames);
  return {
    allowedToolNames: [
      ...new Set(
        input.requestedToolNames.filter((toolName) => parentEffectiveToolNames.has(toolName)),
      ),
    ],
    deniedToolNames: [
      ...new Set(
        input.requestedToolNames.filter((toolName) => !parentEffectiveToolNames.has(toolName)),
      ),
    ],
  };
}

function readRequiredObject(
  record: Record<string, unknown>,
  fieldName: string,
): Record<string, unknown> {
  const value = record[fieldName];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("task-bundle-invalid", `任务包字段 ${fieldName} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(
  record: Record<string, unknown>,
  fieldName: string,
): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "task-bundle-invalid",
      `任务包字段 ${fieldName} 必须是非空字符串。`,
    );
  }
  return value.trim();
}

function readStringArray(record: Record<string, unknown>, fieldName: string): string[] {
  const value = record[fieldName];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DomainError("task-bundle-invalid", `任务包字段 ${fieldName} 必须是字符串数组。`);
  }
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
}
