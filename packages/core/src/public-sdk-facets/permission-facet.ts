/**
 * AXIOMATIC-DESIGN 阶段②（P2，2026-11-26）：**权限域子门面**。
 *
 * 从 `public-sdk.ts`（8540 行、覆盖全部 FR）中切出"权限查询/预览/参数规则读改写"这一组方法：
 * 只依赖 controller 的权限查询入口、参数授权设置存储与两个纯判定函数 ⇒ 依赖面窄、可独立测试。
 *
 * 约束：
 * - 行为与门面原实现逐字一致（含 `assertOpen()` 先判）；
 * - 门面保留同名方法并委托（导出面不变）；
 * - 宿主以**窄接口**注入，避免子门面反向依赖 8540 行门面类型；
 * - 错误构造由宿主注入（避免子门面反向 import 门面模块造成循环依赖）。
 */
import {
  evaluateParameterAuthorization,
  type ParameterAuthorizationRule,
} from "../tools/parameter-authorization.js";
import {
  evaluateParameterAuthorizationSettingChange,
  type ParameterAuthorizationSettingChangeOutcome,
  type ParameterAuthorizationSettingsStore,
  type ToolAuthorizationShape,
} from "../tools/parameter-authorization-settings-store.js";

/** 参数授权设置的**公开只读视图**（SDK 消费者用）。 */
export interface PublicParameterAuthorizationSettings {
  isParameterAuthorizationEnabled: boolean;
  isParameterRulesEnabled: boolean;
  configurationRevision: number;
  ruleCount: number;
}

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
  /** 设置写入被拒时由宿主构造领域错误（保持对外错误类型与既有实现一致）。 */
  createSettingsWriteRejectedError(message: string): Error;
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

  /**
   * AUTH-UI-01：无副作用判定预览。
   * 只读当前 profile / 参数授权设置 / 规则，不改任何状态、不调用模型。
   */
  async previewParameterAuthorization(input: {
    readonly toolName: string;
    readonly action: string;
    readonly argumentsJson: string;
  }): Promise<{
    status: "ok" | "unknown-tool" | "invalid-arguments" | "preview-unavailable";
    decision: "allow" | "ask" | "deny" | null;
    source: "tool-baseline" | "parameter-rule" | null;
    appliedRuleExplanation: string | null;
    isRuleEvaluationSkipped: boolean;
    baselineDecision: "allow" | "ask" | "deny" | null;
    capabilityIds: string[];
    configurationRevision: number;
    message: string | null;
  }> {
    this.host.assertOpen();
    let parsedArguments: Record<string, unknown>;
    try {
      const parsed = JSON.parse(input.argumentsJson || "{}") as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          status: "invalid-arguments",
          decision: null,
          source: null,
          appliedRuleExplanation: null,
          isRuleEvaluationSkipped: false,
          baselineDecision: null,
          capabilityIds: [],
          configurationRevision: 0,
          message: "参数必须是 JSON 对象。",
        };
      }
      parsedArguments = parsed as Record<string, unknown>;
    } catch {
      return {
        status: "invalid-arguments",
        decision: null,
        source: null,
        appliedRuleExplanation: null,
        isRuleEvaluationSkipped: false,
        baselineDecision: null,
        capabilityIds: [],
        configurationRevision: 0,
        message: "参数不是合法 JSON。",
      };
    }
    const baseline = await this.host.permissionController.previewToolPermission({
      toolName: input.toolName,
      action: input.action,
    });
    if (baseline.status === "unknown-tool") {
      return {
        status: "unknown-tool",
        decision: null,
        source: null,
        appliedRuleExplanation: null,
        isRuleEvaluationSkipped: false,
        baselineDecision: null,
        capabilityIds: [],
        configurationRevision: 0,
        message: "未知工具：" + input.toolName,
      };
    }
    if (baseline.baselineDecision === null) {
      return {
        status: "preview-unavailable",
        decision: null,
        source: null,
        appliedRuleExplanation: null,
        isRuleEvaluationSkipped: false,
        baselineDecision: null,
        capabilityIds: baseline.capabilityIds,
        configurationRevision: 0,
        message: "当前权限组不可读，无法预览。",
      };
    }
    const store = this.host.createParameterAuthorizationSettingsStore();
    const document = await store.readSettings();
    if (document.settings.isParameterAuthorizationEnabled !== true) {
      return {
        status: "ok",
        decision: baseline.baselineDecision,
        source: "tool-baseline",
        appliedRuleExplanation: null,
        isRuleEvaluationSkipped: true,
        baselineDecision: baseline.baselineDecision,
        capabilityIds: baseline.capabilityIds,
        configurationRevision: document.configurationRevision ?? 0,
        message: "参数授权总开关关闭：只按工具基线判定。",
      };
    }
    const outcome = evaluateParameterAuthorization({
      toolName: input.toolName,
      action: input.action,
      argumentsJson: JSON.stringify(parsedArguments),
      baselineDecision: baseline.baselineDecision,
      settings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: document.settings.isParameterRulesEnabled,
      },
      rules: document.rules,
    });
    return {
      status: "ok",
      decision: outcome.decision,
      source: outcome.source,
      appliedRuleExplanation: outcome.appliedRuleExplanation,
      isRuleEvaluationSkipped: outcome.isRuleEvaluationSkipped,
      baselineDecision: baseline.baselineDecision,
      capabilityIds: baseline.capabilityIds,
      configurationRevision: document.configurationRevision ?? 0,
      message: null,
    };
  }

  /** 读取参数授权设置（只读、零副作用）。 */
  async queryParameterAuthorizationSettings(): Promise<PublicParameterAuthorizationSettings> {
    this.host.assertOpen();
    const store = this.host.createParameterAuthorizationSettingsStore();
    const settingsDocument = await store.readSettings();
    return {
      isParameterAuthorizationEnabled:
        settingsDocument.settings.isParameterAuthorizationEnabled,
      isParameterRulesEnabled: settingsDocument.settings.isParameterRulesEnabled,
      configurationRevision: settingsDocument.configurationRevision ?? 0,
      ruleCount: settingsDocument.rules.length,
    };
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

  /**
   * GUI-03-03：GUI 规则集写入。
   * 服务端重新读取当前规则、检查 revision 和放宽项；不做"信任浏览器确认"的捷径。
   */
  async updateParameterAuthorizationRules(input: {
    isParameterAuthorizationEnabled: boolean;
    isParameterRulesEnabled: boolean;
    perToolRulesEnabled?: Record<string, boolean>;
    rules: ParameterAuthorizationRule[];
    expectedRevision: number;
    isConfirmedByAuthenticatedUser: boolean;
  }): Promise<{
    status: "saved" | "rejected" | "confirmation-required";
    revision: number;
    widenedRules: string[];
    message: string | null;
  }> {
    this.host.assertOpen();
    const store = this.host.createParameterAuthorizationSettingsStore();
    const current = await store.readSettings();
    const currentRevision = current.configurationRevision ?? 0;
    if (currentRevision !== input.expectedRevision) {
      return {
        status: "rejected",
        revision: currentRevision,
        widenedRules: [],
        message: "配置 revision 已变化，请刷新后重试。",
      };
    }
    const previous = new Map<string, string>();
    for (const rule of current.rules) {
      previous.set(rule.ruleIdentifier ?? rule.toolName + "|" + rule.action, rule.decision);
    }
    const widenedRules = input.rules
      .filter((rule) => {
        const key = rule.ruleIdentifier ?? rule.toolName + "|" + rule.action;
        const old = previous.get(key);
        return rule.decision === "allow" && old !== undefined && old !== "allow";
      })
      .map((rule) => rule.ruleIdentifier ?? rule.toolName + "|" + rule.action);
    if (widenedRules.length > 0 && !input.isConfirmedByAuthenticatedUser) {
      return {
        status: "confirmation-required",
        revision: currentRevision,
        widenedRules,
        message: "本次修改会放宽 " + String(widenedRules.length) + " 条规则，需要明确确认。",
      };
    }
    try {
      const updated = await store.replaceDocument({
        settings: {
          isParameterAuthorizationEnabled: input.isParameterAuthorizationEnabled,
          isParameterRulesEnabled: input.isParameterRulesEnabled,
          perToolRulesEnabled: input.perToolRulesEnabled ?? {},
        },
        rules: input.rules,
        expectedRevision: currentRevision,
      });
      return {
        status: "saved",
        revision: updated.configurationRevision ?? currentRevision + 1,
        widenedRules,
        message: null,
      };
    } catch (error) {
      if (typeof error === "object" && error !== null && "errorCode" in error) {
        return {
          status: "rejected",
          revision: currentRevision,
          widenedRules,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
  }

  /**
   * 写入参数授权设置。
   *
   * 宽判定放在真实写入路径上：未确认即拒绝，且**不写任何文件**（不得半生效）。
   */
  async updateParameterAuthorizationSettings(input: {
    isParameterAuthorizationEnabled: boolean;
    isParameterRulesEnabled: boolean;
    toolAuthorizationShapes: ToolAuthorizationShape[];
    isConfirmedByAuthenticatedUser: boolean;
  }): Promise<ParameterAuthorizationSettingChangeOutcome> {
    this.host.assertOpen();
    const store = this.host.createParameterAuthorizationSettingsStore();
    const settingsDocument = await store.readSettings();
    const changeOutcome = evaluateParameterAuthorizationSettingChange({
      previousSettings: {
        isParameterAuthorizationEnabled:
          settingsDocument.settings.isParameterAuthorizationEnabled,
        isParameterRulesEnabled: settingsDocument.settings.isParameterRulesEnabled,
      },
      nextSettings: {
        isParameterAuthorizationEnabled: input.isParameterAuthorizationEnabled,
        isParameterRulesEnabled: input.isParameterRulesEnabled,
      },
      tools: input.toolAuthorizationShapes,
      isConfirmedByAuthenticatedUser: input.isConfirmedByAuthenticatedUser,
      configurationRevision: settingsDocument.configurationRevision ?? 0,
      effectiveRevision: settingsDocument.configurationRevision ?? 0,
    });
    if (!changeOutcome.isAccepted) {
      return changeOutcome;
    }
    const writeResult = await store.writeSettings({
      settings: {
        isParameterAuthorizationEnabled: input.isParameterAuthorizationEnabled,
        isParameterRulesEnabled: input.isParameterRulesEnabled,
      },
      rules: settingsDocument.rules,
      configurationRevision: changeOutcome.configurationRevision,
    });
    if (!writeResult.isValid) {
      throw this.host.createSettingsWriteRejectedError(
        "参数授权设置写入被拒绝: " + String(writeResult.reason),
      );
    }
    return changeOutcome;
  }
}
