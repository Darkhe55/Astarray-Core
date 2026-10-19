/**
 * USAGE-01-01（2026-10-19 R67）：**请求级账目 / 来源 / 修订契约**。
 *
 * 卡内依据（`docs/tasks/OBS01_PERFORMANCE_USAGE_AND_DIAGNOSTICS_TASK_CARDS.md` §USAGE）：
 * "请求级账目/来源/修订契约及现有捕获审计；**同键异参拒绝**，明确**总量/子量**、
 * **估算与账单边界**"；§2 "数据来源区分本地测量、Provider 返回、估算、缺失和不支持；
 * **unknown 不记作零**"。
 *
 * 判定纪律：
 * 1. **同一请求键**（`requestIdentifier` + 修订）重复写入：内容相同 ⇒ 幂等复用；
 *    内容不同 ⇒ **拒绝**（同键异参）；
 * 2. **来源必须显式**：`provider`（账单级）/ `local-estimate`（估算）/ `missing`（缺失）—— 不许省略；
 * 3. **估算不能当账单**：`local-estimate` 的金额只能标为估算，且**不允许**声明"已结算/可开票"；
 * 4. **未知不记作零**：`missing` ⇒ 计数写 `null` + 原因，而不是 0；
 * 5. **总量与子量**：`inputTokens`/`outputTokens` 必须与 `totalTokens` 自洽（子量之和不大于总量）。
 *
 * ## 边界
 * 纯判定：不读 Provider、不写账本、不估算价格。
 */
/** 账目来源。 */
export type UsageSourceKind = "provider" | "local-estimate" | "missing";

/** 一条请求级账目。 */
export interface UsageLedgerEntryV1 {
  readonly schemaVersion: 1;
  readonly requestIdentifier: string;
  readonly requestRevision: number;
  readonly sourceKind: UsageSourceKind;
  /** 缺失时必须是 null（unknown 不记作零）。 */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** 是否可据以结算/开票；只有 provider 来源且非缺失时才可能为 true。 */
  readonly isBillable: boolean;
  /** 缺失原因（`missing` 来源必须给出）。 */
  readonly missingReason: string | null;
}

/** 写入/校验结论。 */
export type UsageLedgerWriteDecision =
  | { readonly kind: "accepted"; readonly entry: UsageLedgerEntryV1; readonly reason: string }
  | { readonly kind: "idempotent-replay"; readonly reason: string }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "missing-request-identifier"
        | "invalid-revision"
        | "unknown-not-zeroed"
        | "missing-reason-absent"
        | "totals-inconsistent"
        | "estimate-claimed-billable"
        | "same-key-different-parameters";
      readonly reason: string;
    };

/** 校验并规范化一条账目（不含幂等判定）。 */
export function buildUsageLedgerEntry(input: {
  readonly requestIdentifier: string;
  readonly requestRevision: number;
  readonly sourceKind: UsageSourceKind;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly isBillable?: boolean;
  readonly missingReason?: string | null;
}): UsageLedgerWriteDecision {
  if (input.requestIdentifier.trim() === "") {
    return {
      kind: "rejected",
      reasonCode: "missing-request-identifier",
      reason: "缺少请求标识：请求级账目必须能对到具体请求。",
    };
  }
  if (!Number.isInteger(input.requestRevision) || input.requestRevision < 1) {
    return {
      kind: "rejected",
      reasonCode: "invalid-revision",
      reason: "请求修订必须是 ≥1 的整数（用于区分流式/重算的终值）。",
    };
  }

  const inputTokens = input.inputTokens ?? null;
  const outputTokens = input.outputTokens ?? null;
  const totalTokens = input.totalTokens ?? null;

  if (input.sourceKind === "missing") {
    // 缺失必须显式：计数为 null + 给出原因；不得写 0
    if (
      inputTokens !== null ||
      outputTokens !== null ||
      totalTokens !== null
    ) {
      return {
        kind: "rejected",
        reasonCode: "unknown-not-zeroed",
        reason: "来源缺失时计数必须为 null；写成数字等于把 unknown 当已知（卡内明令禁止）。",
      };
    }
    if (input.missingReason === undefined || input.missingReason === null || input.missingReason.trim() === "") {
      return {
        kind: "rejected",
        reasonCode: "missing-reason-absent",
        reason: "来源缺失必须给出原因（如 provider 未返回 usage）。",
      };
    }
    return {
      kind: "accepted",
      reason: "已按「缺失」记录：计数为 null 且给出原因。",
      entry: {
        schemaVersion: 1,
        requestIdentifier: input.requestIdentifier,
        requestRevision: input.requestRevision,
        sourceKind: "missing",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        isBillable: false,
        missingReason: input.missingReason,
      },
    };
  }

  if (inputTokens === null || outputTokens === null || totalTokens === null) {
    return {
      kind: "rejected",
      reasonCode: "unknown-not-zeroed",
      reason: "有来源的账目必须给出 input/output/total 三项；缺项应改用 `missing` 来源并说明原因。",
    };
  }
  for (const tokenCount of [inputTokens, outputTokens, totalTokens]) {
    if (!Number.isFinite(tokenCount) || tokenCount < 0) {
      return {
        kind: "rejected",
        reasonCode: "totals-inconsistent",
        reason: "token 计数必须是非负有限数。",
      };
    }
  }
  if (inputTokens + outputTokens > totalTokens) {
    return {
      kind: "rejected",
      reasonCode: "totals-inconsistent",
      reason: "子量之和大于总量：总量与子量不自洽。",
    };
  }

  // 估算不得声明可结算
  const isBillable = input.isBillable === true;
  if (input.sourceKind === "local-estimate" && isBillable) {
    return {
      kind: "rejected",
      reasonCode: "estimate-claimed-billable",
      reason: "本地估算不能声明可结算/可开票（估算与账单边界必须清楚）。",
    };
  }

  return {
    kind: "accepted",
    reason:
      input.sourceKind === "provider"
        ? "Provider 返回的账目：可用于账单对账。"
        : "本地估算账目：仅作估算，不可结算。",
    entry: {
      schemaVersion: 1,
      requestIdentifier: input.requestIdentifier,
      requestRevision: input.requestRevision,
      sourceKind: input.sourceKind,
      inputTokens,
      outputTokens,
      totalTokens,
      isBillable: input.sourceKind === "provider" && isBillable,
      missingReason: null,
    },
  };
}

/** 同键判定：同 ID 同修订，内容相同 ⇒ 幂等；内容不同 ⇒ 拒绝。 */
export function evaluateUsageLedgerAppend(input: {
  readonly candidate: UsageLedgerEntryV1;
  readonly existingEntries: ReadonlyArray<UsageLedgerEntryV1>;
}): UsageLedgerWriteDecision {
  const existingEntry = input.existingEntries.find(
    (entry) =>
      entry.requestIdentifier === input.candidate.requestIdentifier &&
      entry.requestRevision === input.candidate.requestRevision,
  );
  if (existingEntry === undefined) {
    return { kind: "accepted", entry: input.candidate, reason: "新的请求级账目。" };
  }
  const isSameContent =
    existingEntry.sourceKind === input.candidate.sourceKind &&
    existingEntry.inputTokens === input.candidate.inputTokens &&
    existingEntry.outputTokens === input.candidate.outputTokens &&
    existingEntry.totalTokens === input.candidate.totalTokens &&
    existingEntry.isBillable === input.candidate.isBillable;
  if (isSameContent) {
    return {
      kind: "idempotent-replay",
      reason: "同一请求与修订、内容一致：幂等复用（不重复计费）。",
    };
  }
  return {
    kind: "rejected",
    reasonCode: "same-key-different-parameters",
    reason: "同一请求与修订但内容不同：拒绝写入（不得让同一次调用被记两次或改数）。",
  };
}
