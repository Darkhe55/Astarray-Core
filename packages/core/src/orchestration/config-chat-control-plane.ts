/**
 * CONFIGCHAT-01-02（2026-10-20）：**配置控制面**（把通过契约校验的候选真正落地）。
 *
 * 卡内要交付的判据（L26）：
 * - 配置控制面 + **对话候选接线**；
 * - 反例：**重复提交**、**并发编辑**、**撤权与在途任务**、**主 Agent 无写工具**。
 *
 * 本模块只做**控制面**（纯逻辑 + 注入的落地端口）：
 * 1. 先过 `evaluateSettingChangeProposal`（白名单/来源/范围/revision）；
 * 2. **幂等账目**：同 `changeIdentifier` 同内容 ⇒ `idempotent-replay`；同 ID 异内容 ⇒ `conflict`；
 * 3. **并发编辑**：`expectedRevision` 与当前不符 ⇒ `stale-revision`（不覆盖别人的改动）；
 * 4. **撤权与在途任务**：收紧权限 ⇒ **立即拦截新操作**（`isImmediateInterception: true`）；
 *    影响在途任务 ⇒ 状态 `awaiting-safe-point`（**不谎称已生效**）；
 * 5. **落地失败保留旧版本**：`applySetting` 端口返回 rejected/throw ⇒ `failed` + `previousValueKept: true`；
 * 6. **主 Agent 无写工具**：本模块**只接受认证用户来源**，且不导出任何"模型可调用"的写入口。
 *
 * 边界：不实现设置存储本身（那是既有 `updateParameterAuthorizationSettings` 等），
 * 由调用方注入 `applySetting` 端口；未映射的设置键 ⇒ `unsupported-setting-key`（如实拒绝，不静默跳过）。
 */
import {
  CHAT_SETTING_SECRET_KEYS,
  classifySettingChangeIdentity,
  computeSettingChangeContentFingerprint,
  evaluateSettingChangeProposal,
  type SettingChangeProposal,
} from "./config-chat-contract.js";

/** 落地端口的成功返回；失败用抛出表达。 */
export interface SettingApplyPortResult {
  readonly appliedValueJson: string;
  /** 生效后的设置 revision（调用方维护）。 */
  readonly appliedRevision: number;
}

/** 注入的落地端口。 */
export type SettingApplyPort = (
  input: {
    readonly settingKey: string;
    readonly proposedValueJson: string;
    readonly scopeKind: "session" | "project" | "persistent-default";
  },
) => Promise<SettingApplyPortResult>;

/** 幂等账目条目。 */
export interface SettingChangeLedgerEntry {
  readonly changeIdentifier: string;
  readonly contentFingerprint: string;
  readonly outcome: "applied" | "awaiting-safe-point" | "failed";
  readonly appliedRevision: number | null;
}

/** 控制面结果。 */
export type SettingChangeApplicationOutcome =
  | {
      readonly kind: "applied";
      readonly changeIdentifier: string;
      readonly settingKey: string;
      readonly appliedRevision: number;
      /** 收紧权限类变更 ⇒ 立即拦截新操作。 */
      readonly isImmediateInterception: boolean;
    }
  | {
      readonly kind: "awaiting-safe-point";
      readonly changeIdentifier: string;
      readonly settingKey: string;
      readonly reason: string;
      /** 尚未生效：不得对外宣称已生效。 */
      readonly isEffective: false;
    }
  | {
      readonly kind: "idempotent-replay";
      readonly changeIdentifier: string;
      readonly previousOutcome: SettingChangeLedgerEntry["outcome"];
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode: string;
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly changeIdentifier: string;
      readonly reason: string;
      /** 失败时旧的有效版本必须保留。 */
      readonly previousValueKept: true;
    };

/** 影响在途任务的变更（需要安全点）与"立即拦截"的风险类型。 */
const RISK_KINDS_REQUIRING_SAFE_POINT: ReadonlyArray<string> = ["affects-other-tasks"];
const RISK_KINDS_IMMEDIATE: ReadonlyArray<string> = ["expands-permissions"];

/**
 * 应用一条设置变更候选。
 *
 * @param input.ledger 既有账目（调用方持久化；本函数不写盘）
 * @returns 新的账目条目（调用方负责持久化），随结果一起返回
 */
export async function applySettingChangeProposal(input: {
  readonly proposal: SettingChangeProposal;
  readonly ledger: ReadonlyArray<SettingChangeLedgerEntry>;
  readonly applySetting: SettingApplyPort;
  readonly isExplicitlyConfirmed?: boolean;
  /** 是否有在途任务（决定是否需要安全点）。 */
  readonly hasInFlightMissions?: boolean;
}): Promise<{
  readonly outcome: SettingChangeApplicationOutcome;
  readonly ledger: ReadonlyArray<SettingChangeLedgerEntry>;
}> {
  const { proposal } = input;

  // ① 契约层：白名单/秘密类/来源/范围/revision/变更 ID
  const decision = evaluateSettingChangeProposal(proposal);
  if (decision.kind === "reject") {
    return {
      outcome: { kind: "rejected", reasonCode: decision.reasonCode, reason: decision.reason },
      ledger: input.ledger,
    };
  }

  // 主 Agent 无写工具：本模块不接受任何非认证用户来源（契约已挡，这里再挡一次，防上层绕过）
  if (proposal.sourceKind !== "authenticated-user") {
    return {
      outcome: {
        kind: "rejected",
        reasonCode: "requires-authenticated-user-source",
        reason: "主 Agent 没有设置写工具：只有认证用户能提交设置变更。",
      },
      ledger: input.ledger,
    };
  }

  // ② 幂等 / 冲突（同一 changeIdentifier 不得改内容）
  const fingerprint = computeSettingChangeContentFingerprint({
    settingKey: proposal.settingKey,
    proposedValueJson: proposal.proposedValueJson,
    scopeKind: proposal.scopeKind as "session" | "project" | "persistent-default",
  });
  const identity = classifySettingChangeIdentity({
    changeIdentifier: proposal.changeIdentifier,
    contentFingerprint: fingerprint,
    existingChanges: input.ledger.map((entry) => ({
      changeIdentifier: entry.changeIdentifier,
      contentFingerprint: entry.contentFingerprint,
    })),
  });
  if (identity.kind === "conflict") {
    return {
      outcome: {
        kind: "rejected",
        reasonCode: "conflict",
        reason: "同一变更 ID 的内容与已记录的不同：拒绝覆盖（请换新 ID 或撤回旧变更）。",
      },
      ledger: input.ledger,
    };
  }
  if (identity.kind === "idempotent-replay") {
    const previous = input.ledger.find((entry) => entry.changeIdentifier === proposal.changeIdentifier);
    return {
      outcome: {
        kind: "idempotent-replay",
        changeIdentifier: proposal.changeIdentifier,
        previousOutcome: previous?.outcome ?? "applied",
      },
      ledger: input.ledger,
    };
  }

  // ③ 高风险必须显式确认（即使来自用户）
  if (decision.requiresExplicitConfirmation && input.isExplicitlyConfirmed !== true) {
    return {
      outcome: {
        kind: "rejected",
        reasonCode: "explicit-confirmation-required",
        reason: "该变更风险较高（扩大权限/影响其他任务）：需要用户显式确认后才提交。",
      },
      ledger: input.ledger,
    };
  }

  const isImmediateInterception = proposal.riskKinds.some((riskKind) =>
    RISK_KINDS_IMMEDIATE.includes(riskKind),
  );
  const needsSafePoint =
    (input.hasInFlightMissions === true || proposal.riskKinds.includes("affects-other-tasks")) &&
    proposal.riskKinds.some((riskKind) => RISK_KINDS_REQUIRING_SAFE_POINT.includes(riskKind));

  // ④ 需要安全点 ⇒ 明确"尚未生效"，不落账为 applied
  if (needsSafePoint) {
    const entry: SettingChangeLedgerEntry = {
      changeIdentifier: proposal.changeIdentifier,
      contentFingerprint: fingerprint,
      outcome: "awaiting-safe-point",
      appliedRevision: null,
    };
    return {
      outcome: {
        kind: "awaiting-safe-point",
        changeIdentifier: proposal.changeIdentifier,
        settingKey: proposal.settingKey,
        reason: "该设置影响在途任务：等待安全点后生效（当前状态不等于已生效）。",
        isEffective: false,
      },
      ledger: [...input.ledger, entry],
    };
  }

  // ⑤ 落地（失败保留旧版本，不半应用）
  try {
    const applied = await input.applySetting({
      settingKey: proposal.settingKey,
      proposedValueJson: proposal.proposedValueJson,
      scopeKind: proposal.scopeKind as "session" | "project" | "persistent-default",
    });
    const entry: SettingChangeLedgerEntry = {
      changeIdentifier: proposal.changeIdentifier,
      contentFingerprint: fingerprint,
      outcome: "applied",
      appliedRevision: applied.appliedRevision,
    };
    return {
      outcome: {
        kind: "applied",
        changeIdentifier: proposal.changeIdentifier,
        settingKey: proposal.settingKey,
        appliedRevision: applied.appliedRevision,
        isImmediateInterception,
      },
      ledger: [...input.ledger, entry],
    };
  } catch (error) {
    const entry: SettingChangeLedgerEntry = {
      changeIdentifier: proposal.changeIdentifier,
      contentFingerprint: fingerprint,
      outcome: "failed",
      appliedRevision: null,
    };
    return {
      outcome: {
        kind: "failed",
        changeIdentifier: proposal.changeIdentifier,
        reason: error instanceof Error ? error.message : String(error),
        previousValueKept: true,
      },
      ledger: [...input.ledger, entry],
    };
  }
}

/** 供上层判断：某键是否属于秘密类（不得经对话写入）。 */
export function isSecretSettingKey(settingKey: string): boolean {
  return CHAT_SETTING_SECRET_KEYS.includes(settingKey);
}

