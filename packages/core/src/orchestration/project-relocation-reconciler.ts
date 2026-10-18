/**
 * RELOCATE-01-03 接线片（2026-10-19 R31）：**冷启动/按需对账的判定编排**。
 *
 * 用户 2026-10-19 决策（按推荐）：
 * 1. **触发点**：冷启动只处理"进行中/未决"项目（不扫全库），其余按需；
 * 2. **自动恢复边界**：解析无歧义 + 路径存在 + 权限仍满足 ⇒ **只读类/无副作用**可自动恢复；
 *    **含写或外部副作用必须人工确认**；
 * 3. **不满足时**：项目置 `blocked` 等待用户，**不自动降级、不重放**；
 * 4. 对账入口：`astarray project reconcile`（命令名按推荐）；
 * 5. **符号链接/junction 指向项目外**：一律**拒绝**并要求重新授权；
 * 6. `project status --json` 的 `relocation` 段**可选**（仅存在重定位状态时出现）。
 *
 * 本模块只做**判定编排**：把既有的结构化路径解析（`resolveStructuredResourcePath`）与
 * 恢复门禁（`decideRecoveryAfterRelocation`）组合成"这个项目现在能不能自动恢复"，
 * 不读盘、不调模型、不重放任何操作。
 */
import {
  resolveStructuredResourcePath,
  type ProjectLocationMapping,
  type StructuredResourceReference,
} from "./project-relocation-path-resolution.js";
import {
  decideRecoveryAfterRelocation,
  type PendingOperationObservation,
  type RelocationRecoveryDecision,
} from "./project-relocation-recovery-gate.js";

/** 项目在重定位视角下的状态。 */
export type RelocationProjectStatus = "in-progress" | "unresolved" | "completed";

/** 一条待处理操作及其现场观测。 */
export interface RelocationPendingOperationInput {
  readonly operation: PendingOperationObservation;
  /** 在**新位置**重新执行当前权限检查的结果。 */
  readonly hasCurrentPermissionAtNewLocation: boolean;
  /** 该操作是否依赖换路径前的**一次性许可**。 */
  readonly reliesOnPreviousOneTimeGrant: boolean;
  /** 该操作是否依赖换路径前的**临时权限提升**。 */
  readonly reliesOnTemporaryEscalation: boolean;
}

/** 对账结果。 */
export interface ProjectRelocationReconciliation {
  readonly kind: "reconciled" | "blocked" | "skipped-already-completed";
  readonly projectIdentifier: string;
  readonly resolvedReferences: ReadonlyArray<{
    readonly requestedPath: string;
    readonly resolvedPath: string;
    readonly wasRewritten: boolean;
  }>;
  readonly unresolvedReferences: ReadonlyArray<{
    readonly requestedPath: string;
    readonly rejectionCode: string;
    readonly reason: string;
  }>;
  readonly pendingOperationDecisions: ReadonlyArray<{
    readonly operationIdentifier: string;
    readonly decisionKind: RelocationRecoveryDecision["kind"];
    readonly rejectionCode: string | null;
  }>;
  /** 是否允许**自动**恢复（只读、无副作用、全部解析且无阻塞）。 */
  readonly isAutoResumeAllowed: boolean;
  /** 是否允许执行（含写）—— **人工确认前恒 false**。 */
  readonly isExecutionAllowed: boolean;
  readonly requiredUserAction: string;
}

/**
 * 对一个项目做重定位对账。
 *
 * 判定次序：
 * 1. `completed` ⇒ `skipped-already-completed`（**已完成绝不重放**）；
 * 2. 任一引用解析失败 ⇒ `blocked`（不自动降级）；
 * 3. 任一待处理操作被门禁阻塞 ⇒ `blocked`；
 * 4. 解析成功但**含写/外部副作用** ⇒ 不阻塞，但 `isExecutionAllowed:false` + 需人工确认；
 * 5. 只读且一切干净 ⇒ `isAutoResumeAllowed:true`（仍 `isExecutionAllowed:true` 仅限只读语义）。
 */
export function reconcileProjectRelocation(input: {
  readonly projectIdentifier: string;
  readonly projectStatus: RelocationProjectStatus;
  readonly locationMappings: ReadonlyArray<ProjectLocationMapping>;
  /** schema **声明**允许改写的资源种类（空集合 ⇒ 什么都不改写）。 */
  readonly declaredStructuredResourceKinds: ReadonlyArray<string>;
  readonly references: ReadonlyArray<StructuredResourceReference>;
  readonly pendingOperations: ReadonlyArray<RelocationPendingOperationInput>;
  /** 本次恢复是否包含写或外部副作用（决定能否自动恢复）。 */
  readonly hasWriteOrExternalSideEffects: boolean;
}): ProjectRelocationReconciliation {
  if (input.projectStatus === "completed") {
    return {
      kind: "skipped-already-completed",
      projectIdentifier: input.projectIdentifier,
      resolvedReferences: [],
      unresolvedReferences: [],
      pendingOperationDecisions: [],
      isAutoResumeAllowed: false,
      isExecutionAllowed: false,
      requiredUserAction: "该项目已完成：不重放、不自动恢复。",
    };
  }

  const resolvedReferences: Array<{
    requestedPath: string;
    resolvedPath: string;
    wasRewritten: boolean;
  }> = [];
  const unresolvedReferences: Array<{
    requestedPath: string;
    rejectionCode: string;
    reason: string;
  }> = [];
  for (const reference of input.references) {
    const resolution = resolveStructuredResourcePath({
      reference,
      mappings: input.locationMappings,
      declaredStructuredResourceKinds: input.declaredStructuredResourceKinds,
    });
    if (resolution.kind === "resolved") {
      resolvedReferences.push({
        requestedPath: resolution.requestedPath,
        resolvedPath: resolution.resolvedPath,
        wasRewritten: resolution.wasRewritten,
      });
    } else {
      unresolvedReferences.push({
        requestedPath: reference.requestedPath,
        rejectionCode: resolution.rejectionCode,
        reason: resolution.reason,
      });
    }
  }

  const pendingOperationDecisions = input.pendingOperations.map((pendingOperation) => {
    const decision = decideRecoveryAfterRelocation({
      operation: pendingOperation.operation,
      hasCurrentPermissionAtNewLocation: pendingOperation.hasCurrentPermissionAtNewLocation,
      reliesOnPreviousOneTimeGrant: pendingOperation.reliesOnPreviousOneTimeGrant,
      reliesOnTemporaryEscalation: pendingOperation.reliesOnTemporaryEscalation,
    });
    return {
      operationIdentifier: pendingOperation.operation.operationIdentifier,
      decisionKind: decision.kind,
      rejectionCode: decision.kind === "blocked" ? decision.rejectionCode : null,
    };
  });

  if (unresolvedReferences.length > 0) {
    return {
      kind: "blocked",
      projectIdentifier: input.projectIdentifier,
      resolvedReferences,
      unresolvedReferences,
      pendingOperationDecisions,
      isAutoResumeAllowed: false,
      isExecutionAllowed: false,
      requiredUserAction: "有引用无法解析（见 unresolvedReferences）：请人工确认新路径后重新授权；不自动降级、不重放。",
    };
  }

  const isBlockedByOperation = pendingOperationDecisions.some(
    (decision) => decision.decisionKind === "blocked",
  );
  if (isBlockedByOperation) {
    return {
      kind: "blocked",
      projectIdentifier: input.projectIdentifier,
      resolvedReferences,
      unresolvedReferences,
      pendingOperationDecisions,
      isAutoResumeAllowed: false,
      isExecutionAllowed: false,
      requiredUserAction:
        "存在被门禁阻塞的未决操作（一次性许可不恢复/需新位置权限复检/副作用未知）：请对账后再继续。",
    };
  }

  if (input.hasWriteOrExternalSideEffects) {
    return {
      kind: "reconciled",
      projectIdentifier: input.projectIdentifier,
      resolvedReferences,
      unresolvedReferences,
      pendingOperationDecisions,
      // 含写 ⇒ **必须人工确认**（卡内"含写或外部副作用必须人工确认"）
      isAutoResumeAllowed: false,
      isExecutionAllowed: false,
      requiredUserAction: "路径已解析，但恢复包含写/外部副作用：请人工确认后继续（不自动恢复）。",
    };
  }

  return {
    kind: "reconciled",
    projectIdentifier: input.projectIdentifier,
    resolvedReferences,
    unresolvedReferences,
    pendingOperationDecisions,
    isAutoResumeAllowed: true,
    isExecutionAllowed: true,
    requiredUserAction: "只读恢复对账：路径已解析且无阻塞，可直接继续。",
  };
}


