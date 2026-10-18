/**
 * CURATE-01-01（EXP-01，2026-10-18 R12）：授权式历史梳理的**方案预览、首次授权与重大变更矩阵**。
 *
 * 卡内依据（`docs/tasks/EXP01_WORKFLOW_DISCOVERY_AND_HISTORY_MAINTENANCE_TASK_CARDS.md` §4）：
 * - 首次自动梳理前必须向认证用户**展示方案**：处理哪些会话/项目/个体、排除哪些；频率、时区、
 *   工作时段、首次时间与触发方式；用确定性索引还是模型摘要、用哪个已获准 Provider/模型、
 *   哪些片段会发送给它；保留/删除策略；预算；以及可撤销；
 * - **未授权零自动整理**；用户拒绝 ⇒ 保留旧方案或停用（由用户选择）；
 * - **重大变更必须再次授权**，且由**本地确定性字段比较**强制认定，**不能只靠模型自觉**：
 *   ①扩大项目/会话/个体/数据类别或改变可见性；②新增/更换超出已批准集合的 Provider/模型、
 *   增加对外传输或外发内容类别；③提高频率、资源/费用上限、扩大执行时段或新工具权限；
 *   ④从"新增摘要"改成"重写/删除原文"、改变保留策略或处理目的；⑤方法显著改变信息保留方式；
 *   **无法确定是否重大的变化按重大处理**；
 * - **授权等待只暂停新方案，旧方案在仍有效且安全时可继续**；**新授权绑定精确 revision**，
 *   不能批准后再改参数；纯 UI 展示调整/不改变处理行为的错误修正可记小版本，**但留变更记录**。
 *
 * ## 边界
 * 纯判定：不调度、不调模型、不写盘、不删任何原文。
 */
import { createHash } from "node:crypto";

/** 梳理方案（v1，字段与卡内要求一一对应）。 */
export interface CurationPlanV1 {
  readonly schemaVersion: 1;
  /** 每次重大变更递增（授权绑定它）。 */
  readonly planRevision: number;
  readonly projectIdentifiers: ReadonlyArray<string>;
  readonly sessionIdentifiers: ReadonlyArray<string>;
  readonly agentInstanceIdentifiers: ReadonlyArray<string>;
  readonly dataCategories: ReadonlyArray<string>;
  readonly frequencyMinutes: number;
  readonly timeZone: string;
  readonly workWindowStartMinuteOfDay: number;
  readonly workWindowEndMinuteOfDay: number;
  readonly approvedProviderIdentifiers: ReadonlyArray<string>;
  readonly providerIdentifier: string;
  readonly modelIdentifier: string;
  readonly outboundContentCategories: ReadonlyArray<string>;
  /** 默认只新增/更新派生摘要与索引；`rewrite-or-delete` 属重大变更。 */
  readonly retentionPolicy: "derived-only" | "rewrite-or-delete";
  readonly summarizationMethodIdentifier: string;
  readonly classificationMethodIdentifier: string;
  readonly maximumMonthlyTokens: number;
  /** 纯 UI 展示调整（不改变处理行为）。 */
  readonly isDisplayOnlyAdjustment: boolean;
}

/** 重大变更分类（逐条对应卡内 ①–⑤）。 */
export type CurationChangeKind =
  | "scope-expanded"
  | "provider-or-model-changed"
  | "outbound-transfer-added"
  | "frequency-increased"
  | "budget-increased"
  | "work-window-expanded"
  | "retention-changed"
  | "method-changed"
  | "unknown-change";

/** 变更比较结论。 */
export interface CurationPlanComparison {
  readonly isMajor: boolean;
  readonly changes: ReadonlyArray<CurationChangeKind>;
  readonly reason: string;
}

/** 方案指纹：授权绑定"精确 revision + 精确参数"。 */
export function computeCurationPlanFingerprint(plan: CurationPlanV1): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        plan.planRevision,
        [...plan.projectIdentifiers].sort(),
        [...plan.sessionIdentifiers].sort(),
        [...plan.agentInstanceIdentifiers].sort(),
        [...plan.dataCategories].sort(),
        plan.frequencyMinutes,
        plan.timeZone,
        plan.workWindowStartMinuteOfDay,
        plan.workWindowEndMinuteOfDay,
        plan.providerIdentifier,
        plan.modelIdentifier,
        [...plan.outboundContentCategories].sort(),
        plan.retentionPolicy,
        plan.summarizationMethodIdentifier,
        plan.classificationMethodIdentifier,
        plan.maximumMonthlyTokens,
        plan.isDisplayOnlyAdjustment,
      ]),
    )
    .digest("hex");
}

function hasNewItem(next: ReadonlyArray<string>, previous: ReadonlyArray<string>): boolean {
  return next.some((item) => !previous.includes(item));
}

/**
 * **本地确定性**比较两个方案，判定是否重大变更。
 *
 * 关键：即使模型声称"只是小改"，只要字段上出现扩大范围/换 Provider/加外发/提频/加预算/
 * 扩时段/改保留策略/换方法，就**必须是重大**；字段有差异但无法归类 ⇒ 按**重大**处理（卡内⑤）。
 */
export function compareCurationPlans(input: {
  readonly previous: CurationPlanV1;
  readonly next: CurationPlanV1;
}): CurationPlanComparison {
  const { previous, next } = input;
  const changes: CurationChangeKind[] = [];

  if (
    hasNewItem(next.projectIdentifiers, previous.projectIdentifiers) ||
    hasNewItem(next.sessionIdentifiers, previous.sessionIdentifiers) ||
    hasNewItem(next.agentInstanceIdentifiers, previous.agentInstanceIdentifiers) ||
    hasNewItem(next.dataCategories, previous.dataCategories)
  ) {
    changes.push("scope-expanded");
  }
  if (
    next.providerIdentifier !== previous.providerIdentifier ||
    next.modelIdentifier !== previous.modelIdentifier ||
    !previous.approvedProviderIdentifiers.includes(next.providerIdentifier)
  ) {
    changes.push("provider-or-model-changed");
  }
  if (hasNewItem(next.outboundContentCategories, previous.outboundContentCategories)) {
    changes.push("outbound-transfer-added");
  }
  if (next.frequencyMinutes < previous.frequencyMinutes) {
    changes.push("frequency-increased");
  }
  if (next.maximumMonthlyTokens > previous.maximumMonthlyTokens) {
    changes.push("budget-increased");
  }
  if (
    next.workWindowStartMinuteOfDay < previous.workWindowStartMinuteOfDay ||
    next.workWindowEndMinuteOfDay > previous.workWindowEndMinuteOfDay
  ) {
    changes.push("work-window-expanded");
  }
  if (
    previous.retentionPolicy === "derived-only" &&
    next.retentionPolicy === "rewrite-or-delete"
  ) {
    changes.push("retention-changed");
  }
  if (
    next.summarizationMethodIdentifier !== previous.summarizationMethodIdentifier ||
    next.classificationMethodIdentifier !== previous.classificationMethodIdentifier
  ) {
    changes.push("method-changed");
  }

  const isIdentical = computeCurationPlanFingerprint(previous) === computeCurationPlanFingerprint(next);
  if (changes.length === 0 && !isIdentical && !next.isDisplayOnlyAdjustment) {
    // 字段确有差异但未归类 ⇒ 按重大处理（卡内：无法确定是否重大的变化按重大处理）
    changes.push("unknown-change");
  }

  const isMajor = changes.length > 0;
  return {
    isMajor,
    changes,
    reason: isMajor
      ? `本地确定性比较判定为重大变更：${changes.join("/")}（模型声称"小改"不能绕过）。`
      : next.isDisplayOnlyAdjustment
        ? "纯 UI 展示调整：记为小版本，但仍保留变更记录。"
        : "方案字段无实质变化。",
  };
}

/** 授权记录（绑定精确 revision 与参数指纹）。 */
export interface CurationAuthorizationV1 {
  readonly schemaVersion: 1;
  readonly planRevision: number;
  readonly planFingerprint: string;
  readonly approvedAtIso: string;
  readonly isAuthenticatedUser: boolean;
  /** 撤销后不自动删除已生成内容。 */
  readonly isRevoked: boolean;
}

/** 运行判定结论。 */
export type CurationRunDecision =
  | { readonly kind: "allowed"; readonly reason: string }
  | {
      readonly kind: "denied";
      readonly reasonCode:
        | "not-authenticated"
        | "no-authorization"
        | "authorization-revoked"
        | "revision-mismatch"
        | "fingerprint-mismatch";
      readonly reason: string;
    };

/**
 * 判定某方案现在能否自动整理（**未授权零自动整理**）。
 *
 * 授权必须：由认证用户给出、未撤销、`planRevision` 相符、且**参数指纹相符**
 * （"不能批准后再改参数"）。
 */
export function evaluateCurationRun(input: {
  readonly plan: CurationPlanV1;
  readonly authorization: CurationAuthorizationV1 | null;
}): CurationRunDecision {
  if (input.authorization === null) {
    return {
      kind: "denied",
      reasonCode: "no-authorization",
      reason: "没有授权：未授权零自动整理。",
    };
  }
  if (!input.authorization.isAuthenticatedUser) {
    return {
      kind: "denied",
      reasonCode: "not-authenticated",
      reason: "授权不是由认证用户给出的。",
    };
  }
  if (input.authorization.isRevoked) {
    return {
      kind: "denied",
      reasonCode: "authorization-revoked",
      reason: "授权已撤销：停止未来执行（已生成内容保留可查）。",
    };
  }
  if (input.authorization.planRevision !== input.plan.planRevision) {
    return {
      kind: "denied",
      reasonCode: "revision-mismatch",
      reason: `授权绑定 revision ${String(input.authorization.planRevision)}，当前 ${String(input.plan.planRevision)}。`,
    };
  }
  if (input.authorization.planFingerprint !== computeCurationPlanFingerprint(input.plan)) {
    return {
      kind: "denied",
      reasonCode: "fingerprint-mismatch",
      reason: "方案参数已在批准后被修改：授权失效（需重新授权）。",
    };
  }
  return { kind: "allowed", reason: "授权有效且绑定当前 revision 与参数。" };
}

/** 方案切换判定（重大变更等待授权时，旧方案可否继续）。 */
export interface CurationPlanTransition {
  readonly decision: "apply-new" | "keep-old-waiting" | "keep-old-or-disable";
  readonly isNewPlanPaused: boolean;
  readonly isOldPlanStillAllowed: boolean;
  readonly userMustChoose: boolean;
  readonly reason: string;
}

/**
 * 判定新旧方案切换。
 *
 * - 非重大 或 已获新授权 ⇒ `apply-new`；
 * - 重大且未授权 ⇒ `keep-old-waiting`：**只暂停新方案**，旧方案在仍有效且安全时可继续；
 * - 用户拒绝 ⇒ `keep-old-or-disable`：由用户选择保留旧方案或停用。
 */
export function evaluateCurationPlanTransition(input: {
  readonly previousPlan: CurationPlanV1;
  readonly nextPlan: CurationPlanV1;
  readonly nextPlanAuthorization: CurationAuthorizationV1 | null;
  readonly isUserRejected: boolean;
}): CurationPlanTransition {
  if (input.isUserRejected) {
    return {
      decision: "keep-old-or-disable",
      isNewPlanPaused: true,
      isOldPlanStillAllowed: true,
      userMustChoose: true,
      reason: "用户拒绝新方案：保留旧方案或停用，由用户选择。",
    };
  }
  const comparison = compareCurationPlans({
    previous: input.previousPlan,
    next: input.nextPlan,
  });
  if (!comparison.isMajor) {
    return {
      decision: "apply-new",
      isNewPlanPaused: false,
      isOldPlanStillAllowed: true,
      userMustChoose: false,
      reason: comparison.reason,
    };
  }
  const nextRunDecision = evaluateCurationRun({
    plan: input.nextPlan,
    authorization: input.nextPlanAuthorization,
  });
  if (nextRunDecision.kind === "allowed") {
    return {
      decision: "apply-new",
      isNewPlanPaused: false,
      isOldPlanStillAllowed: true,
      userMustChoose: false,
      reason: "重大变更已获新授权（绑定精确 revision）：应用新方案。",
    };
  }
  return {
    decision: "keep-old-waiting",
    isNewPlanPaused: true,
    isOldPlanStillAllowed: true,
    userMustChoose: true,
    reason: `重大变更等待授权：只暂停新方案，旧方案在仍有效且安全时可继续。${comparison.reason}`,
  };
}
