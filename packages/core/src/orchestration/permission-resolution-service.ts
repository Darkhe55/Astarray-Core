/**
 * AXIOMATIC-DESIGN 阶段③（P3，2026-11-26）：**权限解析服务**。
 *
 * 把"读当前权限组 → 装配概览 → 预览某次调用 → 计算基线"组装为一个可注入服务：
 * - 端口：`readProfile`（读当前 profile 视图）、能力目录、工具注册表；
 * - 输出与控制器原实现逐字一致（含未知工具、动作命中、无 profile）；
 * - 服务不做 I/O 之外的事：不写盘、不联网、不发事件。
 *
 * 控制器只需在构造时注入端口，不再持有权限判定细节。
 */
import type { PermissionDecisionValue, PermissionProfileView } from "./permission-resolution.js";
import type {
  PermissionCapabilityCatalogPort,
  PermissionToolOverviewEntry,
  ToolRegistryPort,
} from "./permission-overview.js";
import { buildPermissionToolOverview } from "./permission-overview.js";
import { resolveToolBaselineDecision } from "./permission-resolution.js";

export interface PermissionResolutionServicePorts {
  readonly readProfile: () => Promise<PermissionProfileView | null>;
  readonly capabilityCatalog: PermissionCapabilityCatalogPort | null | undefined;
  readonly registry: ToolRegistryPort;
}

export class PermissionResolutionService {
  constructor(private readonly ports: PermissionResolutionServicePorts) {}

  async listToolOverview(): Promise<PermissionToolOverviewEntry[]> {
    const profile = await this.ports.readProfile();
    return buildPermissionToolOverview({
      profile,
      capabilityCatalog: this.ports.capabilityCatalog ?? null,
      registry: this.ports.registry,
    });
  }

  async computeBaseline(
    capabilityIds: readonly string[],
    toolName: string,
  ): Promise<PermissionDecisionValue | null> {
    const profile = await this.ports.readProfile();
    return resolveToolBaselineDecision(profile, capabilityIds, toolName);
  }

  /** AUTH-UI-01：预览某次工具调用的授权结论（无副作用）。 */
  async previewToolPermission(input: { readonly toolName: string; readonly action: string }): Promise<{
    status: "ok" | "unknown-tool";
    baselineDecision: PermissionDecisionValue | null;
    capabilityIds: string[];
  }> {
    const overview = await this.listToolOverview();
    const tool = overview.find((entry) => entry.toolName === input.toolName);
    if (tool === undefined) {
      return { status: "unknown-tool", baselineDecision: null, capabilityIds: [] };
    }
    const actionMatched = tool.actions.find((entry) => entry.action === input.action);
    if (actionMatched !== undefined) {
      return {
        status: "ok",
        baselineDecision: await this.computeBaseline(actionMatched.capabilityIds, input.toolName),
        capabilityIds: [...actionMatched.capabilityIds],
      };
    }
    return {
      status: "ok",
      baselineDecision: tool.baselineDecision,
      capabilityIds: [...tool.capabilityIds],
    };
  }
}
