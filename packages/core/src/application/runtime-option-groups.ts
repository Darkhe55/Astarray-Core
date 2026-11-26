/**
 * AXIOMATIC-DESIGN 阶段⑤（P5，2026-11-26）：`createApplicationRuntime` **选项分组**。
 *
 * 现状：`ApplicationRuntimeOptions` 是 50+ 平铺字段（`isSandbox*`、`isDiagnostic*`、`isPerformance*`…），
 * 调用方难以判断"哪些开关属于同一域"，也容易把执行/观测开关混用。
 *
 * 本模块提供**分组视图**与**归一化**：
 * - 分组字段（`execution` / `observability` / `mission`）是**新增可选入口**，旧平铺字段继续有效；
 * - 同一语义字段同时以"分组 + 平铺"给出且值不同 ⇒ 显式报错（不静默择一）；
 * - 值相同时以分组为准（无歧义），并把结果写回平铺字段，运行时代码无需改动。
 */
export interface ExecutionOptionGroup {
  sandboxExecutionBackend?: unknown;
  isSandboxBackendAutoDetected?: boolean;
  isSandboxWeakIsolationEnabled?: boolean;
  isSandboxWeakIsolationForced?: boolean;
  sandboxApplicationRootPath?: string;
  sandboxHelperExecutablePathOverride?: string;
}

export interface ObservabilityOptionGroup {
  isPerformanceCollectionEnabled?: boolean;
  isDiagnosticCollectionEnabled?: boolean;
  isDiagnosticClusteringEnabled?: boolean;
  isEventControlEnabled?: boolean;
}

export interface MissionOptionGroup {
  isMainAgentProposalAutoSubmitEnabled?: boolean;
  maximumTaskChainCumulativeSourceFiles?: number;
}

export interface RuntimeOptionGroups {
  execution?: ExecutionOptionGroup;
  observability?: ObservabilityOptionGroup;
  mission?: MissionOptionGroup;
}

/** 分组字段 → 平铺字段（唯一映射表，避免两处各写一份）。 */
const GROUP_FIELD_MAPPINGS: ReadonlyArray<{
  readonly group: keyof RuntimeOptionGroups;
  readonly field: string;
  readonly flatKey: string;
}> = [
  { group: "execution", field: "sandboxExecutionBackend", flatKey: "sandboxExecutionBackend" },
  { group: "execution", field: "isSandboxBackendAutoDetected", flatKey: "isSandboxBackendAutoDetected" },
  { group: "execution", field: "isSandboxWeakIsolationEnabled", flatKey: "isSandboxWeakIsolationEnabled" },
  { group: "execution", field: "isSandboxWeakIsolationForced", flatKey: "isSandboxWeakIsolationForced" },
  { group: "execution", field: "sandboxApplicationRootPath", flatKey: "sandboxApplicationRootPath" },
  { group: "execution", field: "sandboxHelperExecutablePathOverride", flatKey: "sandboxHelperExecutablePathOverride" },
  { group: "observability", field: "isPerformanceCollectionEnabled", flatKey: "isPerformanceCollectionEnabled" },
  { group: "observability", field: "isDiagnosticCollectionEnabled", flatKey: "isDiagnosticCollectionEnabled" },
  { group: "observability", field: "isDiagnosticClusteringEnabled", flatKey: "isDiagnosticClusteringEnabled" },
  { group: "observability", field: "isEventControlEnabled", flatKey: "isEventControlEnabled" },
  { group: "mission", field: "isMainAgentProposalAutoSubmitEnabled", flatKey: "isMainAgentProposalAutoSubmitEnabled" },
  { group: "mission", field: "maximumTaskChainCumulativeSourceFiles", flatKey: "maximumTaskChainCumulativeSourceFiles" },
];

export class RuntimeOptionConflictError extends Error {
  readonly errorCode = "invalid-arguments";

  constructor(readonly conflicts: readonly string[]) {
    super(
      "选项冲突：以下字段同时以分组与平铺形式给出且值不同：" + conflicts.join("、") +
        "。请只保留一种写法。",
    );
    this.name = "RuntimeOptionConflictError";
  }
}

/**
 * 把分组字段合并进平铺选项（不修改入参）。
 *
 * - 分组字段为 `undefined` ⇒ 不写入（保留平铺值）；
 * - 平铺字段未设置 ⇒ 直接采用分组值；
 * - 两者都设置且不相等 ⇒ 收集为冲突；`strict !== false` 时抛 `RuntimeOptionConflictError`。
 */
export function resolveRuntimeOptionGroups<T extends object>(
  options: T & { optionGroups?: RuntimeOptionGroups },
  behavior: { readonly strict?: boolean } = {},
): T {
  const groups = options.optionGroups;
  if (groups === undefined) {
    return options;
  }
  const merged: Record<string, unknown> = { ...(options as Record<string, unknown>) };
  delete merged.optionGroups;
  const conflicts: string[] = [];

  for (const mapping of GROUP_FIELD_MAPPINGS) {
    const groupValues = groups[mapping.group] as Record<string, unknown> | undefined;
    if (groupValues === undefined) continue;
    const groupValue = groupValues[mapping.field];
    if (groupValue === undefined) continue;
    const flatValue = (options as unknown as Record<string, unknown>)[mapping.flatKey];
    if (flatValue !== undefined && flatValue !== groupValue) {
      conflicts.push(mapping.flatKey);
      continue;
    }
    merged[mapping.flatKey] = groupValue;
  }

  if (conflicts.length > 0 && behavior.strict !== false) {
    throw new RuntimeOptionConflictError(conflicts);
  }
  return merged as T;
}
