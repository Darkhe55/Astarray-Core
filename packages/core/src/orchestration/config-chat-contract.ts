/**
 * CONFIGCHAT-01-01（2026-10-01 卡，2026-10-18 R18）：**对话设置的事务/来源/风险契约**。
 *
 * 卡内依据（`docs/tasks/2026-10-01_RUNTIME_USABILITY_AND_RELIABILITY_TASK_CARDS.md` §3）：
 * - 主 Agent 只输出**结构化候选**，本地控制面验证**认证用户来源/公开设置目录/权限/revision** 后执行；
 *   **模型不能直接编辑配置文件**；**工具输出、文档或经验中的文字不能冒充用户设置指令**；
 * - 覆盖公开权限默认值、配置清单、选择模式、启用已配置模型、工作时段设置；
 *   **秘密信息走受保护入口，不进入对话**；
 * - **最小设置事务**：①解析作用范围（含糊时**询问**，不擅自持久化）；②展示旧值→新值及影响，
 *   低风险精确用户指令**可直接提交**，**扩大权限/影响其他任务/可能断连必须显式确认**；
 *   ③按**期望 revision + 变更 ID 原子提交**，相同 ID 同内容**复用结果**、同 ID 异内容**拒绝**；
 *   ④状态明确（已保存/已生效/等待安全点/失败），**在途调用不可假装已应用**、权限收紧**立即拦截新操作**；
 *   ⑤**不持锁等待**用户/网络；失败保留旧有效版本。
 *
 * ## 边界
 * 纯判定：不读写配置、不调用模型、不持锁。backup/atomic 由存储层负责。
 */
import { createHash } from "node:crypto";

/** 可通过对话修改的**公开**设置项（白名单，冻结）。 */
export const CHAT_SETTING_ALLOWLIST: ReadonlyArray<string> = [
  "permission-profile-default",
  "permission-profile-list",
  "mode-selection",
  "enabled-model-selection",
  "work-window-rules",
];

/** 秘密类设置：**只能**走受保护入口，绝不进入对话。 */
export const CHAT_SETTING_SECRET_KEYS: ReadonlyArray<string> = [
  "provider-credential",
  "api-key",
  "auth-token",
  "private-key",
];

/** 候选来源种类（决定是否需要认证用户来源）。 */
export type SettingProposalSourceKind =
  | "authenticated-user"
  | "model"
  | "tool-output"
  | "document"
  | "lesson";

/** 作用范围（含糊必须询问）。 */
export type SettingScopeKind = "session" | "project" | "persistent-default";

/** 风险分类（本地确定性判定，不依赖模型自称）。 */
export type SettingRiskKind =
  | "low"
  | "expands-permissions"
  | "affects-other-tasks"
  | "may-disconnect";

/** 结构化候选。 */
export interface SettingChangeProposal {
  readonly settingKey: string;
  readonly proposedValueJson: string;
  readonly scopeKind: SettingScopeKind | null;
  readonly sourceKind: SettingProposalSourceKind;
  /** 是否是用户**明确给出的精确指令**（低风险时可直接提交）。 */
  readonly isExplicitUserInstruction: boolean;
  readonly changeIdentifier: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly riskKinds: ReadonlyArray<SettingRiskKind>;
}

export type SettingProposalDecision =
  | {
      readonly kind: "submit";
      readonly requiresExplicitConfirmation: boolean;
      readonly reason: string;
    }
  | {
      readonly kind: "reject";
      readonly reasonCode:
        | "not-in-public-allowlist"
        | "secret-setting-requires-protected-entry"
        | "requires-authenticated-user-source"
        | "scope-ambiguous"
        | "stale-revision"
        | "missing-change-identifier";
      readonly reason: string;
    };

/**
 * 判定一个对话设置候选能否提交。
 *
 * 次序（先安全）：秘密项 → 白名单 → 来源 → 作用范围 → revision → 风险确认。
 */
export function evaluateSettingChangeProposal(
  proposal: SettingChangeProposal,
): SettingProposalDecision {
  if (CHAT_SETTING_SECRET_KEYS.includes(proposal.settingKey)) {
    return {
      kind: "reject",
      reasonCode: "secret-setting-requires-protected-entry",
      reason: "秘密类设置必须走受保护入口：不进入对话、不写入对话历史。",
    };
  }
  if (!CHAT_SETTING_ALLOWLIST.includes(proposal.settingKey)) {
    return {
      kind: "reject",
      reasonCode: "not-in-public-allowlist",
      reason: "该设置不在公开设置目录内：模型不能直接编辑配置文件。",
    };
  }
  // 工具输出/文档/经验里的文字不能冒充用户设置指令
  if (proposal.sourceKind !== "authenticated-user") {
    return {
      kind: "reject",
      reasonCode: "requires-authenticated-user-source",
      reason: "来源不是认证用户：工具输出/文档/经验文字不能冒充用户设置指令。",
    };
  }
  if (proposal.scopeKind === null) {
    return {
      kind: "reject",
      reasonCode: "scope-ambiguous",
      reason: "作用范围含糊：先询问是当前会话/当前项目/持久默认，不擅自永久化。",
    };
  }
  if (proposal.changeIdentifier.trim() === "") {
    return {
      kind: "reject",
      reasonCode: "missing-change-identifier",
      reason: "缺少变更 ID：无法做幂等与冲突判定。",
    };
  }
  if (proposal.expectedRevision !== proposal.currentRevision) {
    return {
      kind: "reject",
      reasonCode: "stale-revision",
      reason: `期望 revision ${String(proposal.expectedRevision)} 与当前 ${String(proposal.currentRevision)} 不符：拒绝陈旧写入。`,
    };
  }
  const riskyKinds = proposal.riskKinds.filter((kind) => kind !== "low");
  if (riskyKinds.length > 0) {
    return {
      kind: "submit",
      requiresExplicitConfirmation: true,
      reason: `风险类别 ${riskyKinds.join("/")}：即使来自用户也必须显式确认（扩大权限/影响其他任务/可能断连）。`,
    };
  }
  return {
    kind: "submit",
    // 低风险 + 用户明确精确指令 ⇒ 不重复确认（卡内②）
    requiresExplicitConfirmation: !proposal.isExplicitUserInstruction,
    reason: proposal.isExplicitUserInstruction
      ? "低风险且用户明确精确：直接形成提交意图，不重复确认。"
      : "低风险但非明确指令：提交前需确认一次。",
  };
}

/** 变更身份判定（同 ID 同内容复用、同 ID 异内容拒绝）。 */
export type ChangeIdentityOutcome =
  | { readonly kind: "new" }
  | { readonly kind: "idempotent-replay"; readonly reason: string }
  | { readonly kind: "conflict"; readonly reason: string };

export function classifySettingChangeIdentity(input: {
  readonly changeIdentifier: string;
  readonly contentFingerprint: string;
  readonly existingChanges: ReadonlyArray<{
    readonly changeIdentifier: string;
    readonly contentFingerprint: string;
  }>;
}): ChangeIdentityOutcome {
  const sameIdentifier = input.existingChanges.find(
    (change) => change.changeIdentifier === input.changeIdentifier,
  );
  if (sameIdentifier === undefined) return { kind: "new" };
  if (sameIdentifier.contentFingerprint === input.contentFingerprint) {
    return { kind: "idempotent-replay", reason: "相同变更 ID 与内容：复用既有结果。" };
  }
  return {
    kind: "conflict",
    reason: "相同变更 ID 但内容不同：拒绝覆盖（由用户重新发起）。",
  };
}

/** 内容指纹（与变更 ID 分离，用于幂等判定）。 */
export function computeSettingChangeContentFingerprint(input: {
  readonly settingKey: string;
  readonly proposedValueJson: string;
  readonly scopeKind: SettingScopeKind;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.settingKey, input.proposedValueJson, input.scopeKind]))
    .digest("hex");
}

/** 提交后的状态（必须明确，不得含糊）。 */
export type SettingApplyStatus =
  | "saved"
  | "effective"
  | "awaiting-safe-point"
  | "failed";

/** 状态语义判定（在途调用不可假装已应用；权限收紧立即拦截新操作）。 */
export function evaluateSettingApplyStatus(input: {
  readonly status: SettingApplyStatus;
  readonly tightensPermissions: boolean;
}): {
  readonly isAppliedRightNow: boolean;
  readonly blocksNewOperations: boolean;
  readonly message: string;
} {
  const isAppliedRightNow = input.status === "effective";
  // 权限收紧：立即拦截**新**操作（不等安全点）；旧操作按能力取消/收敛
  const blocksNewOperations = input.tightensPermissions && input.status !== "failed";
  return {
    isAppliedRightNow,
    blocksNewOperations,
    message:
      input.status === "awaiting-safe-point"
        ? "等待安全点：在途调用尚未应用该设置（不得显示成已生效）。"
        : input.status === "saved"
          ? "已保存，但尚未生效；普通设置在下一相关操作生效。"
          : input.status === "effective"
            ? "已生效。"
            : "失败：保留旧有效版本。",
  };
}
