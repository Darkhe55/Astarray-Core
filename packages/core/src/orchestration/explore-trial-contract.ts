/**
 * EXPLORE-01-02（EXP-01，2026-10-19 R22）：**有界试验执行、隔离、去重与可复现记录**。
 *
 * 卡内依据（`docs/tasks/EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS.md` §3）：
 * - 「使用**隔离测试目录/worktree、fixture 或假服务**。**禁止**为试探效果在**真实用户数据**、
 *   **生产远端或外部软件**上随机执行破坏性命令」；
 * - 「**随机探索仅在批准的输入/参数/方案空间内**；记录**种子、配置、样本与结果**。
 *   种子只能帮助复现，不承诺远端模型完全确定性」；
 * - 「**不重复探索相同参数和版本组合**，允许记录阴性结果」；
 * - 「重启预算**不刷新**、并发不超限、无进展/休息/取消正确停止」（停止判定复用
 *   `evaluateExplorationStop`，本模块只管**执行门禁与记录**）；
 * - 「外部结果未知按现有对账机制阻塞，不能以"实验失败"理由重放非幂等副作用」。
 *
 * ## 边界
 * 纯判定：不启动试验、不建目录、不调模型、不写盘。
 */
import { createHash } from "node:crypto";

/** 隔离方式（卡内点名的三种）。 */
export type TrialIsolationKind = "isolated-directory" | "fixture" | "fake-service";

/** 一次试验的可复现记录。 */
export interface ExploreTrialRecordV1 {
  readonly schemaVersion: 1;
  readonly trialKey: string;
  readonly parameterCombinationIdentifier: string;
  readonly seedIdentifier: string;
  readonly versionIdentifier: string;
  readonly isolationKind: TrialIsolationKind;
  /** 阴性结果也保留（卡内：允许记录阴性结果）。 */
  readonly resultKind: "passed" | "failed" | "inconclusive";
  /** 可复跑证据（脚本/日志/配置的哈希）。 */
  readonly transcriptHash: string;
}

/** 试验键：同参数+种子+版本 ⇒ 同一键（去重依据）。 */
export function computeExploreTrialKey(input: {
  readonly parameterCombinationIdentifier: string;
  readonly seedIdentifier: string;
  readonly versionIdentifier: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.parameterCombinationIdentifier,
        input.seedIdentifier,
        input.versionIdentifier,
      ]),
    )
    .digest("hex");
}

/** 试验启动判定结论。 */
export type ExploreTrialStartDecision =
  | { readonly kind: "start"; readonly trialKey: string; readonly reason: string }
  | {
      readonly kind: "no-start";
      readonly reasonCode:
        | "real-user-data-forbidden"
        | "production-remote-forbidden"
        | "isolation-missing"
        | "user-cancelled"
        | "rest-period"
        | "budget-exhausted"
        | "concurrency-exceeded";
      readonly reason: string;
    }
  | {
      readonly kind: "deduplicated-replay";
      readonly existingTrial: ExploreTrialRecordV1;
      readonly reason: string;
    };

/**
 * 判定一次试验能否开始。
 *
 * 次序：真实数据/生产远端（**禁止**）→ 隔离方式 → 取消/休息 → 预算 → 并发 → **去重**。
 * 去重命中 ⇒ `deduplicated-replay`（复用既有结果，**不消耗新预算、不重跑**）。
 */
export function evaluateExploreTrialStart(input: {
  readonly parameterCombinationIdentifier: string;
  readonly seedIdentifier: string;
  readonly versionIdentifier: string;
  readonly isolationKind: TrialIsolationKind | null;
  readonly touchesRealUserData: boolean;
  readonly touchesProductionRemote: boolean;
  readonly remainingBudget: { readonly maximumTrials: number; readonly tokens: number };
  readonly activeTrialCount: number;
  readonly sessionConcurrencyLimit: number;
  readonly isUserCancelled: boolean;
  readonly isRestPeriod: boolean;
  readonly existingTrials: ReadonlyArray<ExploreTrialRecordV1>;
}): ExploreTrialStartDecision {
  if (input.touchesRealUserData) {
    return {
      kind: "no-start",
      reasonCode: "real-user-data-forbidden",
      reason: "禁止在真实用户数据上执行探索试验。",
    };
  }
  if (input.touchesProductionRemote) {
    return {
      kind: "no-start",
      reasonCode: "production-remote-forbidden",
      reason: "禁止在生产远端或外部软件上随机执行试验；需要真实验证时单独授权精确操作。",
    };
  }
  if (input.isolationKind === null) {
    return {
      kind: "no-start",
      reasonCode: "isolation-missing",
      reason: "必须声明隔离方式（隔离目录/worktree、fixture 或假服务）。",
    };
  }
  if (input.isUserCancelled) {
    return { kind: "no-start", reasonCode: "user-cancelled", reason: "用户已取消。" };
  }
  if (input.isRestPeriod) {
    return {
      kind: "no-start",
      reasonCode: "rest-period",
      reason: "休息时段不发起新试验。",
    };
  }
  if (
    !Number.isFinite(input.remainingBudget.maximumTrials) ||
    input.remainingBudget.maximumTrials <= 0 ||
    !Number.isFinite(input.remainingBudget.tokens) ||
    input.remainingBudget.tokens <= 0
  ) {
    return {
      kind: "no-start",
      reasonCode: "budget-exhausted",
      reason: "预算已耗尽：先报告或等待，不自行追加。",
    };
  }
  if (
    !Number.isFinite(input.sessionConcurrencyLimit) ||
    input.activeTrialCount >= input.sessionConcurrencyLimit
  ) {
    return {
      kind: "no-start",
      reasonCode: "concurrency-exceeded",
      reason: "并发已达会话上限：其它试验结束后再开始。",
    };
  }

  const trialKey = computeExploreTrialKey({
    parameterCombinationIdentifier: input.parameterCombinationIdentifier,
    seedIdentifier: input.seedIdentifier,
    versionIdentifier: input.versionIdentifier,
  });
  const existingTrial = input.existingTrials.find((trial) => trial.trialKey === trialKey);
  if (existingTrial !== undefined) {
    return {
      kind: "deduplicated-replay",
      existingTrial,
      reason: "相同参数+种子+版本组合已探索过：复用既有结果，不重跑、不消耗预算。",
    };
  }
  return {
    kind: "start",
    trialKey,
    reason: "隔离方式已声明、预算与并发允许、组合未探索。",
  };
}

/** 记录一次试验结果（生成可复现记录）。 */
export function buildExploreTrialRecord(input: {
  readonly parameterCombinationIdentifier: string;
  readonly seedIdentifier: string;
  readonly versionIdentifier: string;
  readonly isolationKind: TrialIsolationKind;
  readonly resultKind: "passed" | "failed" | "inconclusive";
  readonly transcriptHash: string;
}): { readonly kind: "built"; readonly record: ExploreTrialRecordV1 } | {
  readonly kind: "rejected";
  readonly reason: string;
} {
  if (input.transcriptHash.trim() === "" || !/^[0-9a-f]{16,64}$/.test(input.transcriptHash)) {
    return {
      kind: "rejected",
      reason: "缺少可复跑证据哈希（脚本/日志/配置）：不记录不可复现的结果。",
    };
  }
  return {
    kind: "built",
    record: {
      schemaVersion: 1,
      trialKey: computeExploreTrialKey(input),
      parameterCombinationIdentifier: input.parameterCombinationIdentifier,
      seedIdentifier: input.seedIdentifier,
      versionIdentifier: input.versionIdentifier,
      isolationKind: input.isolationKind,
      resultKind: input.resultKind,
      transcriptHash: input.transcriptHash,
    },
  };
}

/**
 * 重启后的预算**不得刷新**。
 *
 * - 有持久化快照 ⇒ 沿用快照（**不重置**）；
 * - 没有快照 ⇒ 视为**未知预算**（保守：不可开始新试验），**不**发放新预算。
 */
export function restoreExploreBudgetAfterRestart(input: {
  readonly persistedBudget: { readonly maximumTrials: number; readonly tokens: number } | null;
}): {
  readonly kind: "restored" | "unknown-budget";
  readonly budget: { readonly maximumTrials: number; readonly tokens: number };
  readonly reason: string;
} {
  if (input.persistedBudget === null) {
    return {
      kind: "unknown-budget",
      budget: { maximumTrials: 0, tokens: 0 },
      reason: "重启后未找到持久化预算：视为耗尽，不刷新预算。",
    };
  }
  return {
    kind: "restored",
    budget: { ...input.persistedBudget },
    reason: "沿用持久化预算（重启不刷新）。",
  };
}
