/**
 * CURATE-01-03（2026-10-20 R105）：**只读视图契约**（方案/结果/来源可查、原文不被静默删除、旧新方案状态明确）。
 *
 * 卡内依据（`docs/tasks/EXP01_...` §4）：
 * "默认只新增/更新派生摘要与索引，**不删减原始历史**；主题和结论**可追溯到原消息/工具回执**"；
 * "按具体 Agent 分别整理；用户聚合视图**只引用有权查看的条目**，不把同级记忆合并进模型上下文"；
 * "权威状态从本地记录提取，模型解释**标明推断**；保留**冲突、否定、未决事项和未知项**"；
 * "撤销不自动删除，**已生成内容保留可查**"；"回滚派生视图**不得覆盖并行用户编辑**"。
 *
 * 本模块把上述要求变成**可执行视图判定**（纯函数）：
 * 1. **原文永不被视图"删除"**：`isOriginalHistoryDeleted` 恒为 false（视图不删原文，删除只走专用入口）；
 * 2. **无来源条目不展示**：缺 `sourceMessageIdentifiers` 与 `sourceToolReceiptIdentifiers` 的条目
 *    进入 `unsourcedItemCount`，**不出现在可查看条目里**（可追溯是硬要求）；
 * 3. **跨个体不合并**：查看者无权查看的其它 Agent 条目被过滤并计数（`filteredByAuthorizationCount`）；
 * 4. **推断必须标注**：`isModelInference` 原样保留在视图项里（不得升格为事实）；
 * 5. **冲突/未决/未知保留并计数**（`retainedUnresolvedCount`）；
 * 6. **旧/新方案状态明确**：每条方案给出 `active` / `pending-approval` / `superseded` / `revoked`，
 *    且撤销后**已生成内容仍可查**（`isRevokedContentRetained: true`）。
 *
 * ## 边界
 * 不读库、不调模型：输入即已有派生条目与授权信息。
 */
/** 派生条目（已被生成的内容）。 */
export interface CurationDerivedItemV1 {
  readonly itemIdentifier: string;
  /** 归属的个体（Agent）标识：用于个体隔离。 */
  readonly ownerAgentInstanceIdentifier: string;
  readonly planRevision: number;
  /** 是否来自模型推断（不得升格为权威事实）。 */
  readonly isModelInference: boolean;
  /** 冲突/否定/未决/未知之一（保留，不自行结案）。 */
  readonly unresolvedKind: "conflict" | "negation" | "pending" | "unknown" | null;
  readonly sourceMessageIdentifiers: ReadonlyArray<string>;
  readonly sourceToolReceiptIdentifiers: ReadonlyArray<string>;
}

/** 方案视图状态。 */
export type CurationPlanViewStatus = "active" | "pending-approval" | "superseded" | "revoked";

/** 单个方案的视图。 */
export interface CurationPlanView {
  readonly planRevision: number;
  readonly status: CurationPlanViewStatus;
  /** 是否可据此继续周期执行（仅 active 为 true）。 */
  readonly isExecutable: boolean;
}

/** 只读视图快照。 */
export interface CurationViewSnapshot {
  readonly plans: ReadonlyArray<CurationPlanView>;
  readonly visibleItems: ReadonlyArray<{
    readonly itemIdentifier: string;
    readonly isModelInference: boolean;
    readonly unresolvedKind: CurationDerivedItemV1["unresolvedKind"];
    readonly sourceMessageCount: number;
    readonly sourceToolReceiptCount: number;
  }>;
  /** 缺来源而**不展示**的条目数（如实报告，不静默丢弃）。 */
  readonly unsourcedItemCount: number;
  /** 因查看者无权查看而被过滤的条目数。 */
  readonly filteredByAuthorizationCount: number;
  /** 保留的冲突/未决/未知条目数。 */
  readonly retainedUnresolvedCount: number;
  /** 恒为 false：本视图不提供删除原文的能力。 */
  readonly isOriginalHistoryDeleted: false;
  /** 撤销后已生成内容仍可查（撤销不删除）。 */
  readonly isRevokedContentRetained: true;
}

/** 构建只读视图。 */
export function buildCurationViewSnapshot(input: {
  readonly plans: ReadonlyArray<{
    readonly planRevision: number;
    readonly isRevoked: boolean;
    readonly isPendingApproval: boolean;
    readonly isSuperseded: boolean;
  }>;
  readonly items: ReadonlyArray<CurationDerivedItemV1>;
  /** 查看者有权查看的个体标识集合（跨个体不合并）。 */
  readonly viewerAuthorizedAgentInstanceIdentifiers: ReadonlySet<string>;
  /** 视图是否只展示 active 方案的条目（缺省 false：历史方案的结果也可查）。 */
  readonly isOnlyActivePlanItems?: boolean;
}): CurationViewSnapshot {
  const plans: CurationPlanView[] = input.plans.map((plan) => {
    const status: CurationPlanViewStatus = plan.isRevoked
      ? "revoked"
      : plan.isPendingApproval
        ? "pending-approval"
        : plan.isSuperseded
          ? "superseded"
          : "active";
    return {
      planRevision: plan.planRevision,
      status,
      // 只有 active 可继续周期执行；撤销/待授权/被取代均不可
      isExecutable: status === "active",
    };
  });
  const activeRevisions = new Set(
    plans.filter((plan) => plan.status === "active").map((plan) => plan.planRevision),
  );

  const visibleItems: Array<CurationViewSnapshot["visibleItems"][number]> = [];
  let unsourcedItemCount = 0;
  let filteredByAuthorizationCount = 0;
  let retainedUnresolvedCount = 0;

  for (const item of input.items) {
    // ① 个体隔离：无权查看 ⇒ 过滤并计数（不合并进视图）
    if (!input.viewerAuthorizedAgentInstanceIdentifiers.has(item.ownerAgentInstanceIdentifier)) {
      filteredByAuthorizationCount += 1;
      continue;
    }
    // ② 可追溯：无任何来源 ⇒ 不展示，但计数
    const hasSource =
      item.sourceMessageIdentifiers.length > 0 || item.sourceToolReceiptIdentifiers.length > 0;
    if (!hasSource) {
      unsourcedItemCount += 1;
      continue;
    }
    // ③ 仅 active 方案条目（可选）
    if (input.isOnlyActivePlanItems === true && !activeRevisions.has(item.planRevision)) {
      continue;
    }
    if (item.unresolvedKind !== null) retainedUnresolvedCount += 1;
    visibleItems.push({
      itemIdentifier: item.itemIdentifier,
      isModelInference: item.isModelInference,
      unresolvedKind: item.unresolvedKind,
      sourceMessageCount: item.sourceMessageIdentifiers.length,
      sourceToolReceiptCount: item.sourceToolReceiptIdentifiers.length,
    });
  }

  return {
    plans,
    visibleItems,
    unsourcedItemCount,
    filteredByAuthorizationCount,
    retainedUnresolvedCount,
    isOriginalHistoryDeleted: false,
    isRevokedContentRetained: true,
  };
}

