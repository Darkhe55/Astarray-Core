/**
 * 启动自动恢复：Phase 1（只读扫描 + 报告，2026-11-05）。
 *
 * 不恢复、不启动任务；只把"如果现在启动，会自动恢复哪些、跳过哪些、为什么"说清楚。
 * 判据：
 * - 关系索引有 mission ↔ 序列/任务映射（缺映射不猜）；
 * - mission 非终态；
 * - 租约**已过期或不存在**（否则说明有活着的进程在跑）；
 * - 序列任务处于 running / blocked（被中断的可继续状态）；
 * - 策略允许且未超出本次上限。
 */
import type { ActorIdentity } from "./task-sequence-controllers.js";

export interface StartupRecoveryCandidateView {
  readonly missionIdentifier: string;
  readonly missionStatus: string | null;
  readonly missionMode: string | null;
  readonly projectIdentifier: string | null;
  readonly conversationIdentifier: string | null;
  readonly sequenceIdentifier: string | null;
  readonly taskIdentifier: string | null;
  readonly sequenceOwnerAgentInstanceIdentifier: string | null;
  readonly sequenceTaskStatus: string | null;
  /** 序列节点优先级（越小越先）；未知按 0。 */
  readonly priorityTier: number | null;
  readonly sequenceOrdinal: number | null;
  /** 租约到期时间；null 表示没有租约（进程已退出）。 */
  readonly leaseExpiresAtIso: string | null;
  readonly labels: readonly string[];
}

export interface StartupRecoverySelectedEntry {
  readonly missionIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly taskIdentifier: string;
  readonly ownerAgentInstanceIdentifier: string;
  readonly labels: readonly string[];
  readonly reason: string;
}

export interface StartupRecoverySkippedEntry {
  readonly missionIdentifier: string;
  readonly reason: string;
}

export interface StartupRecoveryPlan {
  readonly selected: readonly StartupRecoverySelectedEntry[];
  readonly skipped: readonly StartupRecoverySkippedEntry[];
  readonly candidateCount: number;
}

export interface StartupRecoveryPolicyView {
  readonly isEnabled: boolean;
  readonly maximumResumePerStartup: number;
  readonly maximumConcurrentResumes: number;
  readonly allowedTaskLabels: readonly string[];
  readonly requireConfirmationFor: readonly string[];
}

const RESUMABLE_SEQUENCE_STATUSES = new Set(["running", "blocked"]);

/** 单条候选的判定（纯函数；原因字符串直接面向用户/日志）。 */
export function evaluateStartupRecoveryCandidate(
  view: StartupRecoveryCandidateView,
  nowIso: string,
): { isResumable: boolean; skippedReason: string | null } {
  if (view.sequenceIdentifier === null || view.taskIdentifier === null) {
    return { isResumable: false, skippedReason: "缺少序列/任务映射（不猜测归属）" };
  }
  if (view.sequenceOwnerAgentInstanceIdentifier === null) {
    return { isResumable: false, skippedReason: "缺少序列所有者" };
  }
  if (view.missionStatus === null) {
    return { isResumable: false, skippedReason: "mission 状态不可读" };
  }
  if (["done", "cancelled", "failed"].includes(view.missionStatus)) {
    return { isResumable: false, skippedReason: `mission 已是终态 ${view.missionStatus}` };
  }
  if (view.sequenceTaskStatus === null) {
    return { isResumable: false, skippedReason: "序列任务不在该序列中" };
  }
  if (!RESUMABLE_SEQUENCE_STATUSES.has(view.sequenceTaskStatus)) {
    return {
      isResumable: false,
      skippedReason: `序列任务状态为 ${view.sequenceTaskStatus}，不属于被中断的可恢复状态`,
    };
  }
  if (view.leaseExpiresAtIso !== null) {
    const expiresAtMilliseconds = Date.parse(view.leaseExpiresAtIso);
    const nowMilliseconds = Date.parse(nowIso);
    if (!Number.isNaN(expiresAtMilliseconds) && expiresAtMilliseconds > nowMilliseconds) {
      return { isResumable: false, skippedReason: "租约仍有效（有进程在运行）" };
    }
  }
  return { isResumable: true, skippedReason: null };
}

/** 选择 + 排序 + 上限（纯函数，可重放）。 */
export function selectStartupRecoveryPlan(input: {
  readonly views: readonly StartupRecoveryCandidateView[];
  readonly policy: StartupRecoveryPolicyView;
  readonly nowIso: string;
}): StartupRecoveryPlan {
  const skipped: StartupRecoverySkippedEntry[] = [];
  const evaluated: Array<{
    view: StartupRecoveryCandidateView;
    priorityTier: number;
    leaseExpiresAtMilliseconds: number;
  }> = [];
  for (const view of input.views) {
    const decision = evaluateStartupRecoveryCandidate(view, input.nowIso);
    if (!decision.isResumable) {
      skipped.push({
        missionIdentifier: view.missionIdentifier,
        reason: decision.skippedReason ?? "不可恢复",
      });
      continue;
    }
    const hasLabelMatch =
      view.labels.length > 0 &&
      view.labels.some((label) => input.policy.allowedTaskLabels.includes(label));
    if (!hasLabelMatch) {
      skipped.push({
        missionIdentifier: view.missionIdentifier,
        reason: `任务类型未允许自动恢复（标签: ${view.labels.join(", ") || "无"}）`,
      });
      continue;
    }
    if (input.policy.requireConfirmationFor.some((label) => view.labels.includes(label))) {
      skipped.push({
        missionIdentifier: view.missionIdentifier,
        reason: "该任务类型需要用户确认后才能恢复",
      });
      continue;
    }
    evaluated.push({
      view,
      priorityTier: view.priorityTier ?? 0,
      leaseExpiresAtMilliseconds:
        view.leaseExpiresAtIso === null
          ? 0
          : Date.parse(view.leaseExpiresAtIso) || 0,
    });
  }

  evaluated.sort((left, right) => {
    if (left.priorityTier !== right.priorityTier) {
      return left.priorityTier - right.priorityTier;
    }
    if (left.leaseExpiresAtMilliseconds !== right.leaseExpiresAtMilliseconds) {
      return left.leaseExpiresAtMilliseconds - right.leaseExpiresAtMilliseconds;
    }
    return left.view.missionIdentifier.localeCompare(right.view.missionIdentifier);
  });

  if (!input.policy.isEnabled) {
    for (const entry of evaluated) {
      skipped.push({
        missionIdentifier: entry.view.missionIdentifier,
        reason: "启动自动恢复已关闭（仅扫描）",
      });
    }
    return { selected: [], skipped, candidateCount: input.views.length };
  }

  const selected: StartupRecoverySelectedEntry[] = [];
  for (const entry of evaluated) {
    if (selected.length >= input.policy.maximumResumePerStartup) {
      skipped.push({
        missionIdentifier: entry.view.missionIdentifier,
        reason: `超出本次启动上限（${String(input.policy.maximumResumePerStartup)}）`,
      });
      continue;
    }
    selected.push({
      missionIdentifier: entry.view.missionIdentifier,
      sequenceIdentifier: String(entry.view.sequenceIdentifier),
      taskIdentifier: String(entry.view.taskIdentifier),
      ownerAgentInstanceIdentifier: String(
        entry.view.sequenceOwnerAgentInstanceIdentifier,
      ),
      labels: entry.view.labels,
      reason: "被中断且通过策略筛选",
    });
  }
  return { selected, skipped, candidateCount: input.views.length };
}

/** 只读端口（测试可替换；生产由运行时注入）。 */
export interface StartupRecoveryScanPorts {
  readonly listMissionRelations: () => Promise<
    readonly {
      readonly missionIdentifier: string;
      readonly projectIdentifier: string | null;
      readonly conversationIdentifier: string | null;
      readonly taskSequenceIdentifier: string | null;
      readonly taskIdentifier: string | null;
      readonly sequenceOwnerAgentInstanceIdentifier: string | null;
    }[]
  >;
  readonly readMissionSummary: (missionIdentifier: string) => Promise<{
    readonly status: string | null;
    readonly mode: string | null;
  } | null>;
  readonly readLeaseExpiresAtIso: (missionIdentifier: string) => Promise<string | null>;
  readonly readSequenceTask: (input: {
    readonly ownerAgentInstanceIdentifier: string;
    readonly sequenceIdentifier: string;
    readonly taskIdentifier: string;
    readonly viewer: ActorIdentity;
  }) => Promise<{
    readonly status: string;
    readonly priorityTier: number | null;
    readonly sequenceOrdinal: number | null;
  } | null>;
}

export interface StartupRecoveryReport extends StartupRecoveryPlan {
  readonly scannedAtIso: string;
  readonly policy: StartupRecoveryPolicyView;
  readonly views: readonly StartupRecoveryCandidateView[];
}

export async function scanStartupRecoveryCandidates(input: {
  readonly ports: StartupRecoveryScanPorts;
  readonly policy: StartupRecoveryPolicyView;
  readonly nowIso: string;
}): Promise<StartupRecoveryReport> {
  const relations = await input.ports.listMissionRelations();
  const views: StartupRecoveryCandidateView[] = [];
  for (const relation of relations) {
    const mission = await input.ports.readMissionSummary(relation.missionIdentifier);
    const leaseExpiresAtIso = await input.ports.readLeaseExpiresAtIso(
      relation.missionIdentifier,
    );
    let sequenceTaskStatus: string | null = null;
    let priorityTier: number | null = null;
    let sequenceOrdinal: number | null = null;
    if (
      relation.taskSequenceIdentifier !== null &&
      relation.taskIdentifier !== null &&
      relation.sequenceOwnerAgentInstanceIdentifier !== null
    ) {
      const sequenceTask = await input.ports.readSequenceTask({
        ownerAgentInstanceIdentifier: relation.sequenceOwnerAgentInstanceIdentifier,
        sequenceIdentifier: relation.taskSequenceIdentifier,
        taskIdentifier: relation.taskIdentifier,
        viewer: {
          sourceKind: "agent",
          actorId: relation.sequenceOwnerAgentInstanceIdentifier,
        },
      });
      sequenceTaskStatus = sequenceTask?.status ?? null;
      priorityTier = sequenceTask?.priorityTier ?? null;
      sequenceOrdinal = sequenceTask?.sequenceOrdinal ?? null;
    }
    views.push({
      missionIdentifier: relation.missionIdentifier,
      missionStatus: mission?.status ?? null,
      missionMode: mission?.mode ?? null,
      projectIdentifier: relation.projectIdentifier,
      conversationIdentifier: relation.conversationIdentifier,
      sequenceIdentifier: relation.taskSequenceIdentifier,
      taskIdentifier: relation.taskIdentifier,
      sequenceOwnerAgentInstanceIdentifier: relation.sequenceOwnerAgentInstanceIdentifier,
      sequenceTaskStatus,
      priorityTier,
      sequenceOrdinal,
      leaseExpiresAtIso,
      /**
       * Phase 1：类型标签尚未从 mission 元数据派生 ⇒ 一律 unknown（Phase 3 再细化）。
       * 默认策略只允许 normal，因此 Phase 1 不会选中任何任务。
       */
      labels: mission === null ? ["unknown"] : ["unknown"],
    });
  }
  const plan = selectStartupRecoveryPlan({
    views,
    policy: input.policy,
    nowIso: input.nowIso,
  });
  return {
    ...plan,
    scannedAtIso: input.nowIso,
    policy: input.policy,
    views,
  };
}
