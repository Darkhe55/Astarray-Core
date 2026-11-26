/**
 * AXIOMATIC-DESIGN 阶段②（P2，2026-11-26）：**权限域子门面**。
 *
 * 从 `public-sdk.ts`（8540 行、覆盖全部 FR）中先切出"权限查询/预览"这一组方法：
 * 只读、只依赖 controller 的两个查询入口 + 参数授权设置存储 ⇒ 依赖面窄、可独立测试。
 *
 * 约束：
 * - 行为与门面原实现逐字一致（含 `assertOpen()` 先判）；
 * - 门面保留同名方法并委托（导出面不变）；
 * - 宿主以**窄接口**注入，避免子门面反向依赖 8540 行门面类型。
 */
import type { ParameterAuthorizationRule } from "../tools/parameter-authorization.js";
import type { ParameterAuthorizationSettingsStore } from "../tools/parameter-authorization-settings-store.js";

/** 子门面所需的最小宿主能力。 */
export interface PermissionFacetHost {
  readonly permissionController: {
    listPermissionToolOverview(): Promise<
      Array<{
        toolName: string;
        isActionOnly: boolean;
        capabilityIds: string[];
        actions: Array<{ action: string; capabilityIds: string[] }>;
        baselineDecision: "allow" | "ask" | "deny" | null;
        baselineSource: "profile-capabilities" | "unknown";
        isRegistered: boolean;
        isExecutable: boolean;
      }>
    >;
    previewToolPermission(input: {
      readonly toolName: string;
      readonly action: string;
    }): Promise<{
      status: "ok" | "unknown-tool";
      baselineDecision: "allow" | "ask" | "deny" | null;
      capabilityIds: string[];
    }>;
  };
  assertOpen(): void;
  createParameterAuthorizationSettingsStore(): ParameterAuthorizationSettingsStore;
}

export class PermissionFacet {
  constructor(private readonly host: PermissionFacetHost) {}

  /** 与主控制器同名的门面转发（PublicApplicationService 形状要求）。 */
  async listPermissionToolOverview() {
    this.host.assertOpen();
    return await this.host.permissionController.listPermissionToolOverview();
  }

  /** 与主控制器同名的门面转发（PublicApplicationService 形状要求）。 */
  async previewToolPermission(input: { readonly toolName: string; readonly action: string }) {
    this.host.assertOpen();
    return await this.host.permissionController.previewToolPermission(input);
  }

  /** AUTH-UI-01：真实工具权限概览（工具/action/当前基线）。 */
  async queryPermissionToolOverview() {
    this.host.assertOpen();
    return await this.host.permissionController.listPermissionToolOverview();
  }

  /** GUI-03-03：读取参数授权规则明细（只读；供设置页展示，不含凭据）。 */
  async queryParameterAuthorizationRuleDetails(): Promise<{
    isParameterAuthorizationEnabled: boolean;
    isParameterRulesEnabled: boolean;
    perToolRulesEnabled: Record<string, boolean>;
    configurationRevision: number;
    rules: ParameterAuthorizationRule[];
  }> {
    this.host.assertOpen();
    const store = this.host.createParameterAuthorizationSettingsStore();
    const document = await store.readSettings();
    return {
      isParameterAuthorizationEnabled: document.settings.isParameterAuthorizationEnabled,
      isParameterRulesEnabled: document.settings.isParameterRulesEnabled,
      perToolRulesEnabled: document.settings.perToolRulesEnabled ?? {},
      configurationRevision: document.configurationRevision ?? 0,
      rules: document.rules,
    };
  }
}
