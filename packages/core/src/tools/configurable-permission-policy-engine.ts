/**
 * 可配置权限策略引擎（T06F / ADR-0020）。
 * 在 schema 暴露与实际执行前读取当前 profile 快照并裁决：
 * - 未映射工具拒绝（catalog 断言）；
 * - 工具需多项权限时取最严格结果；
 * - profile revision、工具权限映射或调用参数变化后，旧 ask 授权失效
 *   （授权记录绑定 profile revision 与目录版本）；
 * - 模式/权限组选择只能来自认证用户控制面。
 *
 * 内部强制执行层（敏感禁读、自动备份、身份认证、OS 边界等）不属于
 * 可配置权限目录；命中内部层只返回稳定最小"操作不可用"结果，
 * 详细分类只进入受保护内部审计。
 */
import type { PermissionCapabilityCatalog } from "./permission-capability-catalog.js";
import type { PermissionDecision } from "./permission-capability-catalog.js";
import type { PermissionProfileStore } from "./permission-profile-store.js";
import { hashToolArguments } from "../core/permission-policy.js";
import {
  evaluateParameterAuthorization,
  type ParameterAuthorizationRule,
} from "./parameter-authorization.js";
import type {
  PermissionProfileDocument,
  PermissionProfileReference,
} from "./permission-profile-store.js";

export interface ProfileBoundAuthorization {
  profileReference: PermissionProfileReference;
  profileRevision: number;
  catalogVersion: number;
  argumentHash: string;
  expiresAtUnixSeconds: number;
  /**
   * AUTH-CORE-01 第 5 项（2026-11-22）：批准时绑定的**参数规则配置 revision**。
   *
   * 规则或开关变化后，旧批准不得复用（否则"改了策略但旧批准仍放行"）。
   * 旧静态配置视为 0。
   */
  parameterAuthorizationRevision?: number;
}

/** 一次调用实际使用的参数规则配置（含 revision，用于批准失效判定）。 */
export interface ResolvedParameterAuthorizationConfiguration {
  settings: {
    isParameterAuthorizationEnabled: boolean;
    isParameterRulesEnabled: boolean;
    perToolRulesEnabled?: Record<string, boolean>;
  };
  rules: ParameterAuthorizationRule[];
  configurationRevision: number;
}

export interface ConfigurablePermissionPolicyEngineOptions {
  catalog: PermissionCapabilityCatalog;
  profileStore: PermissionProfileStore;
  /** 会话授权（bind revision；revokeAll 由调用方在 profile 切换时调用）。 */
  authorizations?: Map<string, ProfileBoundAuthorization>;
  nowUnixSeconds?: () => number;
  authorizationTtlSeconds?: number;
  /**
   * MERGE-01：参数级授权（总开关 + 该工具细分 + 声明式规则）。
   *
   * 未注入时行为与既有完全一致（不改变任何现存裁决路径）。
   * 判定委托 `evaluateParameterAuthorization`（纯函数，无脚本/无正则）。
   */
  parameterAuthorization?: {
    settings: {
      isParameterAuthorizationEnabled: boolean;
      isParameterRulesEnabled: boolean;
      /** AUTH-CORE-01：按工具的细分开关；缺省回退全局开关。 */
      perToolRulesEnabled?: Record<string, boolean>;
    };
    rules: ParameterAuthorizationRule[];
  };
  /**
   * AUTH-CORE-01 第 5 项：**每次调用**从持久化设置读取规则（规则保存后下一次调用即生效，
   * 不需要重启；批准绑定当时的 configurationRevision）。
   *
   * 提供时优先于静态 `parameterAuthorization`；读取失败返回 null ⇒ 不套用规则
   * （回退工具基线，与"配置不可读"的既有保守取向一致）。
   */
  parameterAuthorizationProvider?: () => Promise<ResolvedParameterAuthorizationConfiguration | null>;
}

export type ConfigurablePermissionDecision =
  | { decision: "allow" }
  | { decision: "ask" }
  | { decision: "deny"; reason: string };

/**
 * 引擎裁决结果（内部审计与 UI 区分；模型只看到 deny/ask/allow）。
 * 内部执行层命中时 reason 为稳定最小文本，不含规则类别。
 */
export class ConfigurablePermissionPolicyEngine {
  private readonly catalog: PermissionCapabilityCatalog;
  private readonly profileStore: PermissionProfileStore;
  private readonly authorizations: Map<string, ProfileBoundAuthorization>;
  private readonly nowUnixSeconds: () => number;
  private readonly authorizationTtlSeconds: number;
  /** MERGE-01：静态参数授权配置（缺省 ⇒ 不套用规则）。 */
  private readonly parameterAuthorization: ResolvedParameterAuthorizationConfiguration | null;
  /** AUTH-CORE-01 第 5 项：每次调用读取规则配置（优先于静态配置）。 */
  private readonly parameterAuthorizationProvider:
    | (() => Promise<ResolvedParameterAuthorizationConfiguration | null>)
    | null;

  constructor(options: ConfigurablePermissionPolicyEngineOptions) {
    this.catalog = options.catalog;
    this.profileStore = options.profileStore;
    this.authorizations = options.authorizations ?? new Map();
    this.nowUnixSeconds = options.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.authorizationTtlSeconds = options.authorizationTtlSeconds ?? 600;
    this.parameterAuthorization =
      options.parameterAuthorization === undefined
        ? null
        : { ...options.parameterAuthorization, configurationRevision: 0 };
    this.parameterAuthorizationProvider = options.parameterAuthorizationProvider ?? null;
  }

  /** 解析本次调用的参数规则配置（provider 优先；读取失败 ⇒ null）。 */
  private async resolveParameterAuthorizationConfiguration(): Promise<ResolvedParameterAuthorizationConfiguration | null> {
    if (this.parameterAuthorizationProvider !== null) {
      try {
        return await this.parameterAuthorizationProvider();
      } catch {
        return null;
      }
    }
    return this.parameterAuthorization;
  }

  /** 读取 profile 快照（内置动态生成；自定义读盘）。 */
  async readProfileSnapshot(
    reference: PermissionProfileReference,
  ): Promise<PermissionProfileDocument> {
    return this.profileStore.readProfile(reference);
  }

  /** 评估工具在该 profile 下的基础决定（最严格结果；支持**逐 action** 能力映射）。 */
  evaluateToolDecision(input: {
    toolName: string;
    action?: string | null;
    profile: PermissionProfileDocument;
  }): PermissionDecision {
    const mapped = this.catalog.evaluateToolPermission({
      toolName: input.toolName,
      ...(input.action === undefined ? {} : { action: input.action }),
      capabilityDecisions: input.profile.capabilityDecisions,
    });
    // 能力映射 deny 是不可放宽的上限；显式工具决定只能在其上收紧或明确覆盖 ask/allow。
    if (mapped === "deny") return "deny";
    const explicit = input.profile.toolDecisions?.[input.toolName];
    return explicit ?? mapped;
  }

  /**
   * 实际执行前裁决：
   * - 未映射工具 → deny（未分类工具拒绝执行）；
   * - 基础决定 deny → deny；
   * - allow → allow；
   * - ask → 检查绑定当前 profile revision 的会话授权，有效则 allow，
   *   否则 ask。
   */
  async decide(input: {
    toolName: string;
    profileReference: PermissionProfileReference;
    argumentsJson: string;
    /**
     * MERGE-01：该调用的 **action**（本仓已有本地确定性事实：工具描述符的 `mutationKind`）。
     * 缺省为空串 ⇒ 参数规则不会按 action 匹配（因此不会误套用其它 action 的规则）。
     */
    action?: string;
  }): Promise<ConfigurablePermissionDecision> {
    if (!this.catalog.isToolMapped(input.toolName)) {
      return {
        decision: "deny",
        reason: "操作不可用",
      };
    }
    const profile = await this.profileStore.readProfile(input.profileReference);
    const baseDecision = this.evaluateToolDecision({
      toolName: input.toolName,
      ...(input.action === undefined ? {} : { action: input.action }),
      profile,
    });
    /**
     * MERGE-01 / AUTH-CORE-01（2026-11-22）：**先隔离候选规则并匹配参数**，
     * 已匹配的规则决定本次调用；无命中才回退工具基线。
     *
     * 旧实现的缺陷：基线 `allow` 时先返回 allow，**参数规则判 `ask` 被吞掉**
     * （基线 allow + 规则 ask 必须进入询问）。现在 ask 一律进入询问路径，
     * 由会话授权（用户批准）细化。
     */
    const parameterConfiguration = await this.resolveParameterAuthorizationConfiguration();
    const parameterOutcome = this.evaluateParameterAuthorizationForCall({
      toolName: input.toolName,
      action: input.action ?? "",
      argumentsJson: input.argumentsJson,
      baselineDecision: baseDecision,
      configuration: parameterConfiguration,
    });
    const effectiveDecision: PermissionDecision =
      parameterOutcome !== null && parameterOutcome.source === "parameter-rule"
        ? parameterOutcome.decision
        : baseDecision;
    if (effectiveDecision === "deny") {
      return {
        decision: "deny",
        reason:
          parameterOutcome !== null && parameterOutcome.source === "parameter-rule"
            ? (parameterOutcome.appliedRuleExplanation ?? "参数规则拒绝")
            : "操作不可用",
      };
    }
    if (effectiveDecision === "allow") {
      return { decision: "allow" };
    }
    // ask：绑定 profile revision 的授权
    const authorizationKey = this.authorizationKey(input.toolName, input.argumentsJson);
    const authorization = this.authorizations.get(authorizationKey);
    if (authorization === undefined) {
      return { decision: "ask" };
    }
    if (authorization.expiresAtUnixSeconds <= this.nowUnixSeconds()) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    if (
      authorization.profileReference.kind === "custom" &&
      (input.profileReference.kind !== "custom" ||
        authorization.profileReference.profileId !== input.profileReference.profileId)
    ) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    if (authorization.profileReference.kind === "builtin") {
      if (input.profileReference.kind !== "builtin") {
        this.authorizations.delete(authorizationKey);
        return { decision: "ask" };
      }
    }
    if (
      authorization.profileRevision !== profile.revision ||
      authorization.catalogVersion !== profile.catalogVersion
    ) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    /**
     * AUTH-CORE-01 第 5 项：**规则/开关变化后旧批准失效**。
     * 否则"改了策略但旧批准仍放行"——批准必须绑定它当时看到的规则版本。
     */
    if (
      (authorization.parameterAuthorizationRevision ?? 0) !==
      (parameterConfiguration?.configurationRevision ?? 0)
    ) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    if (authorization.argumentHash !== this.hashArguments(input.argumentsJson)) {
      this.authorizations.delete(authorizationKey);
      return { decision: "ask" };
    }
    return { decision: "allow" };
  }

  /** 用户裁决后授予（绑定 profile revision 与目录版本；参数哈希）。 */
  async grantSessionAuthorization(input: {
    toolName: string;
    profileReference: PermissionProfileReference;
    argumentsJson: string;
  }): Promise<void> {
    const profile = await this.profileStore.readProfile(input.profileReference);
    const configuration = await this.resolveParameterAuthorizationConfiguration();
    this.authorizations.set(this.authorizationKey(input.toolName, input.argumentsJson), {
      profileReference: input.profileReference,
      profileRevision: profile.revision,
      catalogVersion: profile.catalogVersion,
      argumentHash: this.hashArguments(input.argumentsJson),
      expiresAtUnixSeconds: this.nowUnixSeconds() + this.authorizationTtlSeconds,
      parameterAuthorizationRevision: configuration?.configurationRevision ?? 0,
    });
  }

  private authorizationKey(toolName: string, argumentsJson: string): string {
    return `${toolName}:${this.hashArguments(argumentsJson)}`;
  }

  /**
   * MERGE-01：把参数级配置接到纯函数判定上；未注入配置时返回 null（不改变既有行为）。
   * 会话授权细化等更外层上限由调用方在此结果之后求交。
   */
  private evaluateParameterAuthorizationForCall(input: {
    toolName: string;
    action: string;
    argumentsJson: string;
    baselineDecision: PermissionDecision;
    configuration: ResolvedParameterAuthorizationConfiguration | null;
  }): ReturnType<typeof evaluateParameterAuthorization> | null {
    const configuration = input.configuration;
    if (configuration === null) {
      return null;
    }
    const perTool = configuration.settings.perToolRulesEnabled?.[input.toolName];
    return evaluateParameterAuthorization({
      toolName: input.toolName,
      action: input.action,
      argumentsJson: input.argumentsJson,
      baselineDecision: input.baselineDecision,
      settings: {
        isParameterAuthorizationEnabled: configuration.settings.isParameterAuthorizationEnabled,
        isParameterRulesEnabled: perTool ?? configuration.settings.isParameterRulesEnabled,
      },
      rules: configuration.rules,
    });
  }

  private hashArguments(argumentsJson: string): string {
    // 与 SessionAuthorizationManager 同源：规范化（对象键排序）后哈希，
    // 否则语义等价的参数会失配，用户已批准的调用会被再次要求逐次裁决。
    return hashToolArguments(argumentsJson);
  }
}
