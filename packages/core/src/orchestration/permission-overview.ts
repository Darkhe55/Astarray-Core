/**
 * AXIOMATIC-DESIGN 阶段③（P3，2026-11-26）：**工具权限概览装配**（纯函数 + 端口）。
 *
 * 从 `main-controller.listPermissionToolOverview` 抽出：
 * - 输入：当前权限组视图（可空）、能力目录（可空）、工具注册表（端口）；
 * - 输出：按工具名排序的概览（能力/动作/基线/是否注册与可执行）；
 * - 纯装配：不读存储、不联网；缺能力目录 ⇒ 空数组（**不伪造工具**）。
 */
import type { PermissionDecisionValue, PermissionProfileView } from "./permission-resolution.js";
import { resolveToolBaselineDecision } from "./permission-resolution.js";

export interface PermissionCapabilityCatalogPort {
  listToolMappings(): ReadonlyArray<{
    readonly toolName: string;
    readonly capabilityIds: readonly string[];
  }>;
  listToolActionMappings(): ReadonlyArray<{
    readonly toolName: string;
    readonly actions: Readonly<Record<string, readonly string[]>>;
  }>;
}

export interface ToolRegistryPort {
  listRegisteredNames(): readonly string[];
  isRegistered(toolName: string): boolean;
}

export interface PermissionToolOverviewEntry {
  toolName: string;
  isActionOnly: boolean;
  capabilityIds: string[];
  actions: Array<{ action: string; capabilityIds: string[] }>;
  baselineDecision: PermissionDecisionValue | null;
  baselineSource: "profile-capabilities" | "unknown";
  isRegistered: boolean;
  isExecutable: boolean;
}

export function buildPermissionToolOverview(input: {
  readonly profile: PermissionProfileView | null;
  readonly capabilityCatalog: PermissionCapabilityCatalogPort | null | undefined;
  readonly registry: ToolRegistryPort;
}): PermissionToolOverviewEntry[] {
  const capabilityCatalog = input.capabilityCatalog;
  if (capabilityCatalog === null || capabilityCatalog === undefined) return [];
  const profile = input.profile;

  const wholeTools = capabilityCatalog.listToolMappings();
  const actionMappings = capabilityCatalog.listToolActionMappings();
  const registry = input.registry;
  const registeredNames = registry.listRegisteredNames();
  const toolNames = new Set<string>([
    ...wholeTools.map((entry) => entry.toolName),
    ...actionMappings.map((entry) => entry.toolName),
    ...registeredNames,
  ]);

  return [...toolNames].sort().map((toolName) => {
    const whole = wholeTools.find((entry) => entry.toolName === toolName);
    const actionEntry = actionMappings.find((entry) => entry.toolName === toolName);
    const capabilityIds = whole?.capabilityIds ?? [];
    const actions =
      actionEntry === undefined
        ? []
        : Object.entries(actionEntry.actions).map(([action, ids]) => ({
            action,
            capabilityIds: [...ids],
          }));
    return {
      toolName,
      isActionOnly: capabilityIds.length === 0 && actions.length > 0,
      capabilityIds: [...capabilityIds],
      actions,
      baselineDecision: resolveToolBaselineDecision(profile, capabilityIds, toolName),
      baselineSource:
        profile === null ? ("unknown" as const) : ("profile-capabilities" as const),
      // 注册即可调用（执行端口按注册表装配）；未注册 = 目录已映射但当前内核不可调用。
      isRegistered: registry.isRegistered(toolName),
      isExecutable: registry.isRegistered(toolName),
    };
  });
}
