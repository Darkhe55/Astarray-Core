/**
 * RELOCATE-01 检查点 03：**重定位后的恢复门禁**（2026-10-18 第 16 轮）。
 *
 * 依据卡内 §4：
 * - 「关联后先加载历史及任务列表，再复用恢复流程**只读核对**文件、Git、Provider 未决操作及产物。
 *   原目录失联**不等于**旧操作无副作用」；
 * - 「**已确认完成的不重放**；**未知非幂等副作用 blocked**，不能因换路径重试；
 *   **旧一次性许可和临时提升不恢复**」；
 * - 「重新执行真实路径、符号链接、敏感路径和**当前权限检查**；旧授权**不直接转成**新位置许可」。
 *
 * 纯判定：不做 I/O、不改任务状态。
 */

/** 一条未决/已决操作的观测。 */
export interface PendingOperationObservation {
  readonly operationIdentifier: string;
  /** 是否**已确认完成**（有明确证据）。 */
  readonly isCompleted: boolean;
  /** 是否幂等（重复执行无额外副作用）。 */
  readonly isIdempotent: boolean;
  /** 副作用是否**未知**（原目录失联的典型情形）。 */
  readonly hasUnknownSideEffect: boolean;
}

/** 恢复决定。 */
export type RelocationRecoveryDecision =
  | { readonly kind: "skip-already-completed"; readonly reason: string }
  | { readonly kind: "may-retry"; readonly reason: string }
  | {
      readonly kind: "blocked";
      readonly rejectionCode:
        | "stale-grant-not-restored"
        | "permission-recheck-required"
        | "unknown-side-effect";
      readonly reason: string;
    };

/**
 * 决定换路径后如何处理一条操作。判定顺序是**刻意的**（completed 永远先返回）。
 */
export function decideRecoveryAfterRelocation(input: {
  readonly operation: PendingOperationObservation;
  /** **在新位置**重新执行当前权限检查的结果。 */
  readonly hasCurrentPermissionAtNewLocation: boolean;
  /** 该操作是否依赖**旧的一次性许可**。 */
  readonly reliesOnPreviousOneTimeGrant: boolean;
  /** 该操作是否依赖**已失效的临时提升**。 */
  readonly reliesOnTemporaryEscalation: boolean;
}): RelocationRecoveryDecision {
  const { operation } = input;

  // ① 已确认完成 ⇒ **绝不重放**（即使它依赖旧许可也一样：不重跑就不需要许可）
  if (operation.isCompleted) {
    return {
      kind: "skip-already-completed",
      reason: "该操作已确认完成；换路径后不重放，避免重复副作用。",
    };
  }

  // ② 旧一次性许可 / 临时提升不恢复
  if (input.reliesOnPreviousOneTimeGrant || input.reliesOnTemporaryEscalation) {
    return {
      kind: "blocked",
      rejectionCode: "stale-grant-not-restored",
      reason:
        "该操作依赖旧的一次性许可或临时提升；重定位后不恢复这类授权，需重新取得授权。",
    };
  }

  // ③ 旧授权不直接转成新位置许可 ⇒ 必须在新位置重新通过当前权限检查
  if (!input.hasCurrentPermissionAtNewLocation) {
    return {
      kind: "blocked",
      rejectionCode: "permission-recheck-required",
      reason:
        "该操作在新位置未通过当前权限检查；旧授权不随位置迁移，需重新判定权限。",
    };
  }

  // ④ 未知非幂等副作用 ⇒ blocked（不能因换路径重试）
  if (operation.hasUnknownSideEffect && !operation.isIdempotent) {
    return {
      kind: "blocked",
      rejectionCode: "unknown-side-effect",
      reason:
        "该操作可能已产生副作用但无法确认（原目录失联不等于无副作用）；" +
        "换路径重试可能造成重复副作用，标记 blocked 交人工裁决。",
    };
  }

  // ⑤ 其余情况允许重试（幂等，或副作用已知且已确认未发生）
  return {
    kind: "may-retry",
    reason: "该操作未完成、依赖的授权有效、且副作用可控；允许按既有恢复策略重试。",
  };
}
