/**
 * FOLD-01-03（EXP-01，2026-10-19 R27）：**包的复用、停用与回退判定**。
 *
 * 卡内依据（`docs/tasks/EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS.md` §2）：
 * - 「出现**回归可以停用新版本**，**回退前确认没有未知副作用**，**不自动重跑旧工作流**」；
 * - 「复用工具注册**版本化名称、参数 schema、来源和完整公开用法**」（复用须版本与参数匹配）；
 * - 「权限按**展开后的每个实际步骤**执行前检查；**升级不能静默改变在途实例**」；
 * - 「外部结果未知按现有对账机制阻塞，不能以'实验失败'理由重放非幂等副作用」。
 *
 * ## 边界
 * 纯判定：不执行工作流、不重跑旧工作流、不改注册表、不写盘。
 */
import type { RegisteredFoldPackage } from "./workflow-fold-package.js";

/** 复用判定。 */
export type FoldPackageReuseDecision =
  | {
      readonly kind: "allowed";
      readonly toolIdentifier: string;
      readonly version: number;
      readonly reason: string;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "version-retired"
        | "version-unknown"
        | "parameter-schema-mismatch"
        | "missing-parameter-value";
      readonly reason: string;
    };

/**
 * 判定某个已登记版本能否被复用。
 *
 * - 已**停用**的版本不可复用（`version-retired`）；
 * - 未登记版本不可复用（`version-unknown`）；
 * - 参数必须与登记的 schema **完全一致**（多给/少给都拒绝 ⇒ 防模板注入与漏传副作用目标）；
 * - 每个登记的必填参数都必须有值。
 */
export function evaluateFoldPackageReuse(input: {
  readonly toolIdentifier: string;
  readonly version: number;
  readonly registeredPackages: ReadonlyArray<RegisteredFoldPackage>;
  readonly retiredVersions: ReadonlyArray<{ toolIdentifier: string; version: number }>;
  readonly parameterNames: ReadonlyArray<string>;
  readonly expectedParameterNames: ReadonlyArray<string>;
}): FoldPackageReuseDecision {
  const isRetired = input.retiredVersions.some(
    (retired) =>
      retired.toolIdentifier === input.toolIdentifier && retired.version === input.version,
  );
  if (isRetired) {
    return {
      kind: "rejected",
      reasonCode: "version-retired",
      reason: "该版本已停用：不得复用（回归后停用新版本，旧版本需显式回退）。",
    };
  }
  const registered = input.registeredPackages.some(
    (registeredPackage) =>
      registeredPackage.toolIdentifier === input.toolIdentifier &&
      registeredPackage.version === input.version,
  );
  if (!registered) {
    return {
      kind: "rejected",
      reasonCode: "version-unknown",
      reason: "未登记的版本不得复用：只能调用已注册的版本化包。",
    };
  }
  if (input.parameterNames.some((name) => name.trim() === "")) {
    return {
      kind: "rejected",
      reasonCode: "missing-parameter-value",
      reason: "存在空参数名：拒绝调用。",
    };
  }
  const providedNames = [...input.parameterNames].sort();
  const expectedNames = [...input.expectedParameterNames].sort();
  if (
    providedNames.length !== expectedNames.length ||
    providedNames.some((name, index) => name !== expectedNames[index])
  ) {
    return {
      kind: "rejected",
      reasonCode: "parameter-schema-mismatch",
      reason: "参数与登记 schema 不一致：多给/少给都拒绝（防注入与漏传副作用目标）。",
    };
  }
  return {
    kind: "allowed",
    toolIdentifier: input.toolIdentifier,
    version: input.version,
    reason: "版本已登记且参数与 schema 一致。",
  };
}

/** 回退判定。 */
export type FoldPackageRollbackDecision =
  | { readonly kind: "approved"; readonly fromVersion: number; readonly toVersion: number; readonly reason: string }
  | {
      readonly kind: "blocked";
      readonly reasonCode:
        | "unknown-side-effects"
        | "in-flight-instances"
        | "target-version-unavailable"
        | "same-version";
      readonly reason: string;
    };

/**
 * 判定能否回退到旧版本。
 *
 * 卡内三条硬约束：**回退前确认没有未知副作用**、**升级不能静默改变在途实例**、**不自动重跑旧工作流**。
 */
export function planFoldPackageRollback(input: {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly isTargetVersionAvailable: boolean;
  readonly hasUnknownSideEffects: boolean;
  readonly inFlightInstanceCount: number;
}): FoldPackageRollbackDecision {
  if (input.fromVersion === input.toVersion) {
    return { kind: "blocked", reasonCode: "same-version", reason: "回退目标与当前版本相同。" };
  }
  if (!input.isTargetVersionAvailable) {
    return {
      kind: "blocked",
      reasonCode: "target-version-unavailable",
      reason: "目标版本不可用（未登记或已停用）：不能回退。",
    };
  }
  if (input.hasUnknownSideEffects) {
    return {
      kind: "blocked",
      reasonCode: "unknown-side-effects",
      reason: "存在未知副作用：先对账确认，再回退（不得以'实验失败'重放非幂等副作用）。",
    };
  }
  if (input.inFlightInstanceCount > 0) {
    return {
      kind: "blocked",
      reasonCode: "in-flight-instances",
      reason: "仍有在途实例使用当前版本：先收敛/取消，静默切换会改变在途行为。",
    };
  }
  return {
    kind: "approved",
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    reason: "无未知副作用、无在途实例：可以回退（**不自动重跑**旧工作流）。",
  };
}

/** 发现回归后的响应（停用新版本、不自动重跑）。 */
export function evaluateFoldRegressionResponse(input: {
  readonly hasRegression: boolean;
}): {
  readonly shouldRetireNewVersion: boolean;
  readonly shouldAutoRerunOldWorkflow: false;
  readonly reason: string;
} {
  return {
    shouldRetireNewVersion: input.hasRegression,
    // 恒为 false：卡内"不自动重跑旧工作流"
    shouldAutoRerunOldWorkflow: false,
    reason: input.hasRegression
      ? "发现回归：停用新版本并等待用户决定是否回退；不自动重跑旧工作流。"
      : "未发现回归：保持当前版本。",
  };
}

/**
 * 停用版本（记录原因与受影响实例数；不删除历史）。
 */
export function buildFoldPackageRetirement(input: {
  readonly toolIdentifier: string;
  readonly version: number;
  readonly reason: string;
  readonly affectedInstanceCount: number;
  readonly retiredAtIso: string;
}): {
  readonly kind: "retired";
  readonly record: {
    toolIdentifier: string;
    version: number;
    reason: string;
    affectedInstanceCount: number;
    retiredAtIso: string;
    isHistoryRetained: true;
  };
} | { readonly kind: "rejected"; readonly reason: string } {
  if (input.reason.trim() === "") {
    return { kind: "rejected", reason: "停用必须记录原因。" };
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    return { kind: "rejected", reason: "版本号非法。" };
  }
  return {
    kind: "retired",
    record: {
      toolIdentifier: input.toolIdentifier,
      version: input.version,
      reason: input.reason,
      affectedInstanceCount: input.affectedInstanceCount,
      retiredAtIso: input.retiredAtIso,
      isHistoryRetained: true,
    },
  };
}
