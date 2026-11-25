/**
 * MERGE-01 §1.3 第 4 项：参数授权的**设置入口**（2026-10-10）。
 *
 * 卡内要求："参数授权总开关、每工具细分开关和规则列表"必须是一个**设置入口**，
 * 且默认**全部开启**；同时 §1.2 要求规则优先级 deny>ask>allow、认识不到的参数拒绝。
 *
 * 此前这两个开关**只存在于权限引擎的构造参数里**，全仓 TUI/CLI/GUI/设置零入口，
 * 因此"设置入口"在产品层面不成立（TOOLKIT-01-04 也依赖它）。
 *
 * 本模块是**受控持久化层**：只做读写与校验，不做裁决
 * （裁决仍由纯函数 `evaluateParameterAuthorization` 与权限引擎负责，避免两套结论）。
 */

import {
  evaluateParameterAuthorization,
  type ParameterAuthorizationRule,
} from "./parameter-authorization.js";
import { resolveToolAction } from "./tool-action-registry.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { DomainError } from "../core/errors.js";

export const PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION =
  "ASTARRAY_PARAMETER_AUTHORIZATION_SETTINGS_V1";

const SETTINGS_FILE_NAME = "parameter-authorization-settings.json";

export interface ParameterAuthorizationSettingsDocument {
  schemaVersion: string;
  settings: {
    /** 总开关；默认开启（卡内"默认全部开启"）。 */
    isParameterAuthorizationEnabled: boolean;
    /** 每工具细分开关（全局默认）；默认开启。 */
    isParameterRulesEnabled: boolean;
    /** AUTH-CORE-01：按工具的细分开关；缺省回退全局。 */
    perToolRulesEnabled?: Record<string, boolean>;
  };
  rules: ParameterAuthorizationRule[];
  /**
   * 配置 revision（MERGE-01 §1.3："**配置保存和生效 revision 分开**"）。
   *
   * 可选以兼容旧文件；缺省视为 0。
   */
  configurationRevision?: number;
}

export interface ParameterAuthorizationSettingsStoreOptions {
  stateDirectory: string;
  /**
   * AUTH-CORE-01 第 3 项（2026-11-22）：**运行时已知工具集**。
   *
   * 整工具规则（空 action）无法用 `resolveToolAction` 校验"工具是否存在"，
   * 保存层因此需要运行时注册表给出已知工具名。缺省 ⇒ 跳过该检查（兼容旧构造方）；
   * 返回 null（注册表暂不可读）同样跳过——不能因为诊断不可用就阻断合法保存。
   */
  knownToolNamesProvider?: () => Promise<ReadonlySet<string> | null> | ReadonlySet<string> | null;
}

export interface ParameterAuthorizationSettingsWriteResult {
  isValid: boolean;
  reason: string | null;
}

/** 默认文档：两个开关都开启、无规则（卡内"默认全部开启"）。 */
function buildDefaultDocument(): ParameterAuthorizationSettingsDocument {
  return {
    schemaVersion: PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
    settings: {
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      perToolRulesEnabled: {},
    },
    rules: [],
  };
}

export class ParameterAuthorizationSettingsStore {
  private readonly stateDirectory: string;
  private readonly writeLock = new AsyncMutex();
  private readonly knownToolNamesProvider: ParameterAuthorizationSettingsStoreOptions["knownToolNamesProvider"];

  constructor(options: ParameterAuthorizationSettingsStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.knownToolNamesProvider = options.knownToolNamesProvider;
  }

  private get settingsFilePath(): string {
    return `${this.stateDirectory}/${SETTINGS_FILE_NAME}`;
  }

  private get settingsBackupFilePath(): string {
    return `${this.settingsFilePath}.backup`;
  }

  /**
   * 读取设置。
   *
   * 文件不存在 ⇒ 返回**默认值**（两个开关开启）且**不创建文件**：
   * 为了"看一次设置"而写出配置文件会让"用户是否显式改过"无法区分。
   */
  async readSettings(): Promise<ParameterAuthorizationSettingsDocument> {
    const { readJsonWithBackupRecovery } = await import("../infra/atomic-json.js");
    const readResult = await readJsonWithBackupRecovery(
      this.settingsFilePath,
      this.settingsBackupFilePath,
    );
    if (readResult === null) {
      return buildDefaultDocument();
    }
    const raw = readResult.content as ParameterAuthorizationSettingsDocument;
    // 落盘内容一律重新校验：手工编辑过的坏文件不得被当成有效设置使用。
    const validation = validateSettingsDocument(raw);
    if (!validation.isValid) {
      throw new Error(
        "参数授权设置文件非法（请修正或删除）: " + String(validation.reason),
      );
    }
    return raw;
  }

  /** GUI-03-03：按 expectedRevision 原子替换完整规则集（保留校验与备份）。 */
  async replaceDocument(input: {
    settings: ParameterAuthorizationSettingsDocument["settings"];
    rules: ParameterAuthorizationRule[];
    expectedRevision: number;
  }): Promise<ParameterAuthorizationSettingsDocument> {
    return this.writeLock.runExclusive(async () => {
      const current = await this.readSettings();
      const currentRevision = current.configurationRevision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw new DomainError(
          "stale-revision",
          "参数授权配置 revision 不匹配: 现有 " +
            currentRevision +
            "，期望 " +
            input.expectedRevision,
        );
      }
      const result = await this.writeSettings({
        settings: input.settings,
        rules: input.rules,
        configurationRevision: currentRevision + 1,
      });
      if (!result.isValid) {
        throw new DomainError("invalid-task-chain", result.reason ?? "参数授权配置非法。");
      }
      return this.readSettings();
    });
  }
  /** 写入设置（先校验，非法一律不落盘）。 */
  async writeSettings(
    document: Omit<ParameterAuthorizationSettingsDocument, "schemaVersion"> & {
      schemaVersion?: string;
    },
  ): Promise<ParameterAuthorizationSettingsWriteResult> {
    const candidate: ParameterAuthorizationSettingsDocument = {
      schemaVersion:
        document.schemaVersion ?? PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
      settings: document.settings,
      rules: document.rules,
      /** 保留调用方提供的配置 revision（缺省 0），不静默丢弃。 */
      configurationRevision: document.configurationRevision ?? 0,
    };
    const knownToolNames =
      this.knownToolNamesProvider === undefined
        ? null
        : await Promise.resolve(this.knownToolNamesProvider()).catch(() => null);
    const validation = validateSettingsDocument(candidate, { knownToolNames });
    if (!validation.isValid) {
      return validation;
    }
    const { writeAtomicJson, backupExistingFile } = await import("../infra/atomic-json.js");
    await backupExistingFile(this.settingsFilePath, this.settingsBackupFilePath);
    await writeAtomicJson(this.settingsFilePath, candidate);
    return { isValid: true, reason: null };
  }
}

/**
 * 校验设置文档（**纯函数**、fail-closed）。
 *
 * 拒绝：schemaVersion 不符、开关非布尔、规则非数组、规则缺必需字段、
 * **规则 action 不属于该工具**、**匹配种类未知**、**规则 ID 重复**、
 * 以及规则本身无法被判定器理解（用判定器做一次综合校验）。
 */
export function validateSettingsDocument(
  document: ParameterAuthorizationSettingsDocument,
  options?: {
    /**
     * AUTH-CORE-01 第 3 项：运行时已知工具名；给出时整工具规则（空 action）
     * 必须指向已注册工具，否则拒绝保存（该规则永远不会生效）。
     * 缺省/null ⇒ 跳过该检查（保存层无注册表上下文时保持旧行为）。
     */
    readonly knownToolNames?: ReadonlySet<string> | null;
  },
): ParameterAuthorizationSettingsWriteResult {
  if (
    document === null ||
    typeof document !== "object" ||
    document.schemaVersion !== PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION
  ) {
    return { isValid: false, reason: "schemaVersion 不符或文档结构非法" };
  }
  const settings = document.settings;
  if (settings === null || typeof settings !== "object") {
    return { isValid: false, reason: "settings 缺失" };
  }
  const perToolRulesEnabled = (settings as Record<string, unknown>)["perToolRulesEnabled"];
  if (perToolRulesEnabled !== undefined) {
    if (perToolRulesEnabled === null || typeof perToolRulesEnabled !== "object") {
      return { isValid: false, reason: "perToolRulesEnabled 必须是对象" };
    }
    for (const [toolName, enabled] of Object.entries(
      perToolRulesEnabled as Record<string, unknown>,
    )) {
      if (toolName === "" || typeof enabled !== "boolean") {
        return {
          isValid: false,
          reason: "perToolRulesEnabled 的项必须是 布尔值（tool=" + toolName + "）",
        };
      }
    }
  }
  if (
    typeof settings.isParameterAuthorizationEnabled !== "boolean" ||
    typeof settings.isParameterRulesEnabled !== "boolean"
  ) {
    return {
      isValid: false,
      reason: "参数授权开关必须为布尔值（isParameterAuthorizationEnabled/isParameterRulesEnabled）",
    };
  }
  if (!Array.isArray(document.rules)) {
    return { isValid: false, reason: "rules 必须为数组" };
  }
  const seenRuleIdentifiers = new Set<string>();
  for (const rule of document.rules) {
    if (rule === null || typeof rule !== "object") {
      return { isValid: false, reason: "规则项必须为对象" };
    }
    const ruleRecord = rule as unknown as Record<string, unknown>;
    const ruleIdentifier = ruleRecord["ruleIdentifier"];
    if (typeof ruleIdentifier !== "string" || ruleIdentifier === "") {
      return { isValid: false, reason: "规则缺少 ruleIdentifier" };
    }
    if (seenRuleIdentifiers.has(ruleIdentifier)) {
      return {
        isValid: false,
        reason: "规则 ruleIdentifier 重复（后写会静默覆盖前写）: " + ruleIdentifier,
      };
    }
    seenRuleIdentifiers.add(ruleIdentifier);
    if (typeof ruleRecord["toolName"] !== "string" || ruleRecord["toolName"] === "") {
      return { isValid: false, reason: "规则缺少 toolName: " + ruleIdentifier };
    }
    // AUTH-CORE-01 第 3 项：action 允许为空 ⇒ 整工具规则（无 action 的工具必须有这个入口）。
    if (typeof ruleRecord["action"] !== "string") {
      return { isValid: false, reason: "规则 action 非法: " + ruleIdentifier };
    }
    if (
      ruleRecord["decision"] !== "deny" &&
      ruleRecord["decision"] !== "ask" &&
      ruleRecord["decision"] !== "allow"
    ) {
      return {
        isValid: false,
        reason: "规则 decision 必须是 deny/ask/allow: " + ruleIdentifier,
      };
    }
    /**
     * AUTH-CORE-01 第 3 项：**允许无 match 的整 action 规则**。
     * match 缺省 ⇒ 该 action 一律匹配（判定器已支持，见 doesRuleMatch）；
     * 显式给出 match 时仍做种类校验，禁止正则/脚本等可执行匹配。
     */
    const match = ruleRecord["match"];
    if (match !== undefined) {
      if (match === null || typeof match !== "object") {
        return { isValid: false, reason: "规则 match 非法: " + ruleIdentifier };
      }
      const matchKind = (match as Record<string, unknown>)["kind"];
      if (!KNOWN_MATCH_KINDS.includes(matchKind as (typeof KNOWN_MATCH_KINDS)[number])) {
        return {
          isValid: false,
          reason:
            "规则的匹配种类未知（不得使用正则等可执行匹配）: " + String(matchKind),
        };
      }
      /**
       * AUTH-CORE-01 第 3 项（2026-11-22）：**匹配契约统一校验**。
       *
       * 仅认可种类不够：`{kind:"numeric-range", minimum:5, maximum:1}`、
       * 空 `values`、空 `prefix` 都是"永不生效"或"意外全匹配"的规则，
       * 保存后用户以为配了策略。这里逐字段校验（与判定器读取的字段一致）。
       */
      const matchIssue = validateParameterRuleMatchShape(match);
      if (matchIssue !== null) {
        return { isValid: false, reason: matchIssue + ": " + ruleIdentifier };
      }
    }
    /**
     * 综合校验：把规则交给判定器实测。这样"设置里存了判定器不认识的东西"
     * 会在**保存时**暴露，而不是等到执行时才静默失效。
     */
    const probe = evaluateParameterAuthorization({
      toolName: ruleRecord["toolName"] as string,
      action: ruleRecord["action"] as string,
      argumentsJson: "{}",
      baselineDecision: "ask",
      settings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      },
      rules: [rule as unknown as ParameterAuthorizationRule],
    });
    if (probe.isRuleEvaluationSkipped) {
      return {
        isValid: false,
        reason:
          "规则与工具/action 不匹配（判定器未接受该规则）: " + ruleIdentifier,
      };
    }
    /**
     * 还要确认该 action 是**工具真实存在的 action**。
     *
     * 仅靠判定器不够：一个 `action: "not-an-action"` 的规则只是"永不匹配"，
     * 判定器会如常返回（`isRuleEvaluationSkipped=false`），于是这条**永远不生效**的规则
     * 会被静默保存 —— 用户以为配了策略，实际什么都没发生。故显式拒绝。
     */
    const declaredAction = ruleRecord["action"] as string;
    const knownToolNames = options?.knownToolNames ?? null;
    if (
      declaredAction === "" &&
      knownToolNames !== null &&
      !knownToolNames.has(ruleRecord["toolName"] as string)
    ) {
      return {
        isValid: false,
        reason:
          "规则的 toolName 未在运行时注册（整工具规则将永不生效）: " +
          ruleIdentifier +
          " tool=" +
          String(ruleRecord["toolName"]),
      };
    }
    const knownAction = declaredAction === ""
      ? null
      : resolveToolAction({
          toolNameOrAlias: ruleRecord["toolName"] as string,
          action: declaredAction,
        });
    if (declaredAction !== "" && knownAction === null) {
      return {
        isValid: false,
        reason:
          "规则的 action 不属于该工具（该规则将永不生效，不得静默保存）: " +
          ruleIdentifier +
          " action=" +
          String(ruleRecord["action"]),
      };
    }
  }
  return { isValid: true, reason: null };
}

/** 已登记的匹配种类（与卡内允许的四种一致；**不允许正则/脚本**）。 */
const KNOWN_MATCH_KINDS = [
  "path-prefix",
  "allowed-values",
  "fixed-value",
  "numeric-range",
] as const;

/**
 * AUTH-CORE-01 第 3 项：按**判定器实际读取的字段**校验一条 match 的形状。
 *
 * 返回 `null` 表示合法，否则返回人可读原因（调用方附上规则 ID）。
 * 不做"试算"推断：试算只能证明"此刻不匹配"，证明不了"字段/区间本身有效"。
 */
function validateParameterRuleMatchShape(match: unknown): string | null {
  if (match === null || typeof match !== "object") {
    return "规则 match 非法";
  }
  const record = match as Record<string, unknown>;
  const field = record["field"];
  if (typeof field !== "string" || field === "") {
    return "规则的 match.field 必须是非空字符串";
  }
  switch (record["kind"]) {
    case "path-prefix": {
      const prefix = record["prefix"];
      if (typeof prefix !== "string" || prefix === "") {
        return "path-prefix 的 prefix 必须是非空字符串";
      }
      return null;
    }
    case "allowed-values": {
      const values = record["values"];
      if (!Array.isArray(values) || values.length === 0) {
        return "allowed-values 的 values 必须是非空数组（否则永不生效）";
      }
      if (!values.every((value) => typeof value === "string" && value !== "")) {
        return "allowed-values 的 values 必须全为非空字符串";
      }
      return null;
    }
    case "fixed-value": {
      return typeof record["value"] === "string"
        ? null
        : "fixed-value 的 value 必须是字符串";
    }
    case "numeric-range": {
      const minimum = record["minimum"];
      const maximum = record["maximum"];
      if (typeof minimum !== "number" || !Number.isFinite(minimum)) {
        return "numeric-range 的 minimum 必须是有限数值";
      }
      if (typeof maximum !== "number" || !Number.isFinite(maximum)) {
        return "numeric-range 的 maximum 必须是有限数值";
      }
      if (minimum > maximum) {
        return "numeric-range 的 minimum 不得大于 maximum（否则永不生效）";
      }
      return null;
    }
    default:
      return "规则的匹配种类未知（不得使用正则等可执行匹配）: " + String(record["kind"]);
  }
}

/* ────────── MERGE-01 §1.3：关闭细分**不得静默扩大权限** ────────── */

/** 单条授权效果（三态）。 */
export type PermissionEffect = "deny" | "ask" | "allow";

/** 某工具在当前设置下的授权形态（供变更判定使用）。 */
export interface ToolAuthorizationShape {
  toolName: string;
  /** 统一授权（工具基线）三态。 */
  unifiedEffect: PermissionEffect;
  /** 参数细分规则及其效果。 */
  ruleEffects: Array<{ ruleIdentifier: string; effect: PermissionEffect }>;
}

export interface PermissionChangeEntry {
  toolName: string;
  /** 发生变化的来源：工具基线与某条细分规则。 */
  sourceIdentifier: string;
  previousEffect: PermissionEffect;
  nextEffect: PermissionEffect;
  /** 人可读、简短准确的差异说明（卡内"设置变更展示简短准确差异"）。 */
  displaySummary: string;
}

export interface ParameterAuthorizationSettingChangeOutcome {
  isAccepted: boolean;
  reason: string | null;
  /** 被**放宽**的条目（deny/ask → allow）。 */
  widenedPermissions: PermissionChangeEntry[];
  /** 被**收紧**的条目（allow → deny/ask，或 ask → deny）。 */
  tightenedPermissions: PermissionChangeEntry[];
  /** 是否存在放宽（调用方据此要求确认）。 */
  requiresAuthenticatedUserConfirmation: boolean;
  configurationRevision: number;
  effectiveRevision: number;
  isRevisionAppliedImmediately: boolean;
}

/** 效果强弱：allow 最宽，ask 次之，deny 最严。 */
function permissionEffectRank(effect: PermissionEffect): number {
  if (effect === "allow") {
    return 2;
  }
  if (effect === "ask") {
    return 1;
  }
  return 0;
}

/**
 * 判定一次设置变更的影响（**纯函数**、fail-closed）。
 *
 * 卡内 §1.3："**关闭细分若会从 deny/ask 回退 allow，必须明确提示放宽范围，
 * 不以'关闭功能'静默扩大权限**"；"扩大权限需既有认证用户确认"；
 * "配置保存和生效 revision 分开"。
 *
 * 判定规则：
 *  - 细分**开启**时：逐条规则效果**覆盖**工具基线；未匹配回退基线。
 *    这里按"最宽松的可能结果"保守估计（因为无法穷举全部参数，
 *    **宁可多报放宽也不漏报**）。
 *  - 细分**关闭**（或总开关关闭）时：全部调用只用统一授权（工具基线）。
 *  - 逐项比较前后"实际生效效果"，`next` 比 `previous` **更宽**即计入放宽。
 *  - 存在放宽而**未经认证用户确认** ⇒ 拒绝，且**不推进任何 revision**。
 *
 * **已知保守取向（如实记录）**：某 `deny`/`ask` 规则从"生效"变为"不生效"时，
 * 把该来源效果记为**变为 allow**（参数回到"未被该规则拦截"的状态）—— 这对
 * `deny`/`ask` 精确成立。但在"工具基线本身为 deny、仅有 allow 规则生效"的组合下，
 * 停用该规则应属**收紧**，本实现可能计为放宽。方向是**多报**（会要求人工确认），
 * 属**安全方向**；精确判定需按 action × 参数空间求交，留作后续工作，
 * **不在此宣称完全精确**。
 */
export function evaluateParameterAuthorizationSettingChange(input: {
  previousSettings: {
    isParameterAuthorizationEnabled: boolean;
    isParameterRulesEnabled: boolean;
  };
  nextSettings: {
    isParameterAuthorizationEnabled: boolean;
    isParameterRulesEnabled: boolean;
  };
  tools: readonly ToolAuthorizationShape[];
  isConfirmedByAuthenticatedUser: boolean;
  configurationRevision?: number;
  effectiveRevision?: number;
}): ParameterAuthorizationSettingChangeOutcome {
  const configurationRevision = input.configurationRevision ?? 0;
  const effectiveRevision = input.effectiveRevision ?? configurationRevision;


  const widenedPermissions: PermissionChangeEntry[] = [];
  const tightenedPermissions: PermissionChangeEntry[] = [];

  /**
   * 某来源在给定设置下是否**生效**。
   *
   * 细分未生效（总开关关或该工具细分关）⇒ 只有**统一授权**生效，
   * 规则**完全不参与**裁决（这正是"关闭细分"的实际语义）。
   */
  const isSourceActive = (
    settings: { isParameterAuthorizationEnabled: boolean; isParameterRulesEnabled: boolean },
    source: "unified" | "rule",
  ): boolean => {
    if (source === "unified") {
      return true;
    }
    return settings.isParameterAuthorizationEnabled && settings.isParameterRulesEnabled;
  };

  for (const shape of input.tools) {
    /**
     * 逐**来源**比较（而不是比较"最宽效果"）。
     *
     * 为什么必须逐来源：某工具的基线是 `allow`、但有一条 `deny` 细分规则时，
     * **启用**细分会让该参数从 allow 变成 deny（**收紧**）；
     * 若只比较"最宽效果"就会得出"没有变化甚至变宽"的错误结论 ——
     * 实测中这个错误让"关闭细分"的放宽**完全漏报**。
     */
    const sources: Array<{
      source: "unified" | "rule";
      sourceIdentifier: string;
      effect: PermissionEffect;
    }> = [
      {
        source: "unified",
        sourceIdentifier: shape.toolName + "（统一授权）",
        effect: shape.unifiedEffect,
      },
      ...shape.ruleEffects.map((ruleEffect) => ({
        source: "rule" as const,
        sourceIdentifier: shape.toolName + "（规则 " + ruleEffect.ruleIdentifier + "）",
        effect: ruleEffect.effect,
      })),
    ];

    for (const sourceEntry of sources) {
      const wasActive = isSourceActive(input.previousSettings, sourceEntry.source);
      const isActive = isSourceActive(input.nextSettings, sourceEntry.source);
      if (wasActive === isActive) {
        continue;
      }
      /** 该来源从"生效"变为"不生效" ⇒ 其效果**消失**；反向则**出现**。 */
      const previousEffect: PermissionEffect = wasActive ? sourceEntry.effect : "allow";
      const nextEffect: PermissionEffect = isActive ? sourceEntry.effect : "allow";
      if (previousEffect === nextEffect) {
        continue;
      }
      const changeEntry: PermissionChangeEntry = {
        toolName: shape.toolName,
        sourceIdentifier: sourceEntry.sourceIdentifier,
        previousEffect,
        nextEffect,
        displaySummary:
          sourceEntry.sourceIdentifier +
          "：" +
          previousEffect +
          " → " +
          nextEffect +
          (permissionEffectRank(nextEffect) > permissionEffectRank(previousEffect)
            ? "（放宽范围）"
            : "（收紧）"),
      };
      if (permissionEffectRank(nextEffect) > permissionEffectRank(previousEffect)) {
        widenedPermissions.push(changeEntry);
      } else {
        tightenedPermissions.push(changeEntry);
      }
    }
  }

  const requiresAuthenticatedUserConfirmation = widenedPermissions.length > 0;
  if (requiresAuthenticatedUserConfirmation && !input.isConfirmedByAuthenticatedUser) {
    return {
      isAccepted: false,
      reason:
        "该变更会**放宽**权限（deny/ask → allow），需既有认证用户确认后方可生效: " +
        widenedPermissions.map((entry) => entry.displaySummary).join("；"),
      widenedPermissions,
      tightenedPermissions,
      requiresAuthenticatedUserConfirmation: true,
      // 被拒 ⇒ **不推进任何 revision**（不得半生效）
      configurationRevision,
      effectiveRevision,
      isRevisionAppliedImmediately: false,
    };
  }

  return {
    isAccepted: true,
    reason: null,
    widenedPermissions,
    tightenedPermissions,
    requiresAuthenticatedUserConfirmation,
    configurationRevision: configurationRevision + 1,
    effectiveRevision: effectiveRevision + 1,
    isRevisionAppliedImmediately: true,
  };
}

