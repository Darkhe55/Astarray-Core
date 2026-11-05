/**
 * 启动自动恢复：只读扫描 + 选择（Phase 1，2026-11-05；口径按用户修订）。
 *
 * 用户口径：
 * - 可恢复 = 之前写入任务序列、**仍未完成**的内容（pending/running/blocked 都算）；
 * - 上限按机器负载动态缩放（见 startup-recovery-capacity）；
 * - 含写任务默认也恢复，但报告里带 `requiresNotification` 供 UI 提示。
 *
 * 本模块**只读**：不恢复、不改状态、不启动任务。
 */
import type { ActorIdentity } from "./task-sequence-controllers.js";
import type {
  StartupRecoveryCapacityDecision,
  StartupRecoveryCapacitySample,
} from "./startup-recovery-capacity.js";
import { computeAdaptiveResumeLimit } from "./startup-recovery-capacity.js";
import type { StartupRecoveryPolicy } from "./startup-recovery-policy.js";

export type StartupRecoveryCandidateKind = "mission-resume" | "sequence-only";

export interface StartupRecoveryCandidateView {
  readonly kind: StartupRecoveryCandidateKind;
  readonly missionIdentifier: string | null;
  readonly missionStatus: string | null;
  readonly missionMode: string | null;
  readonly projectIdentifier: string | null;
  readonly conversationIdentifier: string | null;
  readonly sequenceIdentifier: string;
  readonly taskIdentifier: string;
  readonly sequenceOwnerAgentInstanceIdentifier: string;
  readonly sequenceTaskStatus: string;
  readonly priorityTier: number | null;
  readonly sequenceOrdinal: number | null;
  /** 租约到期时间；null 表示没有租约（进程已退出）或非 mission 任务。 */
  readonly leaseExpiresAtIso: string | null;
  readonly labels: readonly string[];
}

export interface StartupRecoverySelectedEntry {
  readonly kind: StartupRecoveryCandidateKind;
  readonly missionIdentifier: string | null;
  readonly sequenceIdentifier: string;
  readonly taskIdentifier: string;
  readonly ownerAgentInstanceIdentifier: string;
  readonly labels: readonly string[];
  /** 含写/需授权时 UI 需要提示（用户口径：默认恢复但有提示）。 */
  readonly requiresNotification: boolean;
  readonly reason: string;
}

export interface StartupRecoverySkippedEntry {
  readonly missionIdentifier: string | null;
  readonly sequenceIdentifier: string;
  readonly taskIdentifier: string;
  readonly reason: string;
}

export interface StartupRecoveryPlan {
  readonly selected: readonly StartupRecoverySelectedEntry[];
  readonly skipped: readonly StartupRecoverySkippedEntry[];
  readonly candidateCount: number;
  readonly effectiveLimit: number;
}

const TERMINAL_SEQUENCE_STATUSES = new Set(["done", "cancelled", "failed"]);
const NOTIFICATION_LABELS = new Set(["has-writes", "needs-permission"]);

export function evaluateStartupRecoveryCandidate(
  view: StartupRecoveryCandidateView,
  nowIso: string,
): { isResumable: boolean; skippedReason: string | null } {
  if (TERMINAL_SEQUENCE_STATUSES.has(view.sequenceTaskStatus)) {
    return { isResumable: false, skippedReason: `序列任务已是终态 ${view.sequenceTaskStatus}` };
  }
  if (view.kind === "mission-resume") {
    if (view.missionIdentifier === null || view.missionStatus === null) {
      return { isResumable: false, skippedReason: "mission 状态不可读" };
    }
    if (["done", "cancelled", "failed"].includes(view.missionStatus)) {
      return { isResumable: false, skippedReason: `mission 已是终态 ${view.missionStatus}` };
    }
    if (view.leaseExpiresAtIso !== null) {
      const expiresAtMilliseconds = Date.parse(view.leaseExpiresAtIso);
      const nowMilliseconds = Date.parse(nowIso);
      if (!Number.isNaN(expiresAtMilliseconds) && expiresAtMilliseconds > nowMilliseconds) {
        return { isResumable: false, skippedReason: "租约仍有效（有进程在运行）" };
      }
    }
  }
  return { isResumable: true, skippedReason: null };
}

export function selectStartupRecoveryPlan(input: {
  readonly views: readonly StartupRecoveryCandidateView[];
  readonly policy: StartupRecoveryPolicy;
  readonly effectiveLimit: number;
  readonly nowIso: string;
}): StartupRecoveryPlan {
  const skipped: StartupRecoverySkippedEntry[] = [];
  const evaluated: Array<{
    view: StartupRecoveryCandidateView;
    leaseExpiresAtMilliseconds: number;
  }> = [];
  for (const view of input.views) {
    const decision = evaluateStartupRecoveryCandidate(view, input.nowIso);
    if (!decision.isResumable) {
      skipped.push({
        missionIdentifier: view.missionIdentifier,
        sequenceIdentifier: view.sequenceIdentifier,
        taskIdentifier: view.taskIdentifier,
        reason: decision.skippedReason ?? "不可恢复",
      });
      continue;
    }
    if (
      !view.labels.some((label) =>
        (input.policy.allowedTaskLabels as readonly string[]).includes(label),
      )
    ) {
      skipped.push({
        missionIdentifier: view.missionIdentifier,
        sequenceIdentifier: view.sequenceIdentifier,
        taskIdentifier: view.taskIdentifier,
        reason: `任务类型未允许自动恢复（标签: ${view.labels.join(", ") || "无"}）`,
      });
      continue;
    }
    if (
      (input.policy.requireConfirmationFor as readonly string[]).some((label) =>
        view.labels.includes(label),
      )
    ) {
      skipped.push({
        missionIdentifier: view.missionIdentifier,
        sequenceIdentifier: view.sequenceIdentifier,
        taskIdentifier: view.taskIdentifier,
        reason: "该任务类型需要用户确认后才能恢复",
      });
      continue;
    }
    evaluated.push({
      view,
      leaseExpiresAtMilliseconds:
        view.leaseExpiresAtIso === null
          ? 0
          : Date.parse(view.leaseExpiresAtIso) || 0,
    });
  }

  evaluated.sort((left, right) => {
    const leftPriority = left.view.priorityTier ?? 0;
    const rightPriority = right.view.priorityTier ?? 0;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    if (left.leaseExpiresAtMilliseconds !== right.leaseExpiresAtMilliseconds) {
      return left.leaseExpiresAtMilliseconds - right.leaseExpiresAtMilliseconds;
    }
    return `${left.view.missionIdentifier ?? ""}:${left.view.sequenceIdentifier}:${left.view.taskIdentifier}`.localeCompare(
      `${right.view.missionIdentifier ?? ""}:${right.view.sequenceIdentifier}:${right.view.taskIdentifier}`,
    );
  });

  if (!input.policy.isEnabled) {
    for (const entry of evaluated) {
      skipped.push({
        missionIdentifier: entry.view.missionIdentifier,
        sequenceIdentifier: entry.view.sequenceIdentifier,
        taskIdentifier: entry.view.taskIdentifier,
        reason: "启动自动恢复已关闭（仅扫描）",
      });
    }
    return { selected: [], skipped, candidateCount: input.views.length, effectiveLimit: 0 };
  }

  const selected: StartupRecoverySelectedEntry[] = [];
  for (const entry of evaluated) {
    if (selected.length >= input.effectiveLimit) {
      skipped.push({
        missionIdentifier: entry.view.missionIdentifier,
        sequenceIdentifier: entry.view.sequenceIdentifier,
        taskIdentifier: entry.view.taskIdentifier,
        reason: `超出本次动态上限（${String(input.effectiveLimit)}）`,
      });
      continue;
    }
    selected.push({
      kind: entry.view.kind,
      missionIdentifier: entry.view.missionIdentifier,
      sequenceIdentifier: entry.view.sequenceIdentifier,
      taskIdentifier: entry.view.taskIdentifier,
      ownerAgentInstanceIdentifier: entry.view.sequenceOwnerAgentInstanceIdentifier,
      labels: entry.view.labels,
      requiresNotification: entry.view.labels.some((label) => NOTIFICATION_LABELS.has(label)),
      reason:
        entry.view.kind === "mission-resume"
          ? "被中断的 mission，可继续"
          : "序列中尚未完成的任务",
    });
  }
  return {
    selected,
    skipped,
    candidateCount: input.views.length,
    effectiveLimit: input.effectiveLimit,
  };
}

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
  /** Phase 3：从 mission 元数据派生标签（含写/需授权/普通）；缺省按 unknown。 */
  readonly readMissionLabels?: (
    missionIdentifier: string,
  ) => Promise<readonly string[]>;
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
  /** 扫描所有序列（用于"序列里有、但没有 mission 映射"的未完成任务）。 */
  readonly listSequenceTasks?: () => Promise<
    readonly {
      readonly ownerAgentInstanceIdentifier: string;
      readonly sequenceIdentifier: string;
      readonly taskIdentifier: string;
      readonly status: string;
      readonly priorityTier: number | null;
      readonly sequenceOrdinal: number | null;
    }[]
  >;
}

export interface StartupRecoveryReport extends StartupRecoveryPlan {
  readonly scannedAtIso: string;
  readonly policy: StartupRecoveryPolicy;
  readonly capacity: StartupRecoveryCapacityDecision;
  readonly views: readonly StartupRecoveryCandidateView[];
}

export async function scanStartupRecoveryCandidates(input: {
  readonly ports: StartupRecoveryScanPorts;
  readonly policy: StartupRecoveryPolicy;
  readonly capacitySample: StartupRecoveryCapacitySample | null;
  readonly nowIso: string;
}): Promise<StartupRecoveryReport> {
  const capacity =
    input.capacitySample === null
      ? computeAdaptiveResumeLimit(
          { ...input.policy, isLoadAdaptive: false },
          { cpuCount: 1, loadAverage1m: null, freeMemoryBytes: 1, totalMemoryBytes: 1 },
        )
      : computeAdaptiveResumeLimit(input.policy, input.capacitySample);

  const relations = await input.ports.listMissionRelations();
  const views: StartupRecoveryCandidateView[] = [];
  const referencedSequenceTasks = new Set<string>();
  for (const relation of relations) {
    if (
      relation.taskSequenceIdentifier === null ||
      relation.taskIdentifier === null ||
      relation.sequenceOwnerAgentInstanceIdentifier === null
    ) {
      continue;
    }
    referencedSequenceTasks.add(
      `${relation.sequenceOwnerAgentInstanceIdentifier}\u0000${relation.taskSequenceIdentifier}\u0000${relation.taskIdentifier}`,
    );
    const mission = await input.ports.readMissionSummary(relation.missionIdentifier);
    const sequenceTask = await input.ports.readSequenceTask({
      ownerAgentInstanceIdentifier: relation.sequenceOwnerAgentInstanceIdentifier,
      sequenceIdentifier: relation.taskSequenceIdentifier,
      taskIdentifier: relation.taskIdentifier,
      viewer: {
        sourceKind: "agent",
        actorId: relation.sequenceOwnerAgentInstanceIdentifier,
      },
    });
    if (sequenceTask === null) continue;
    views.push({
      kind: "mission-resume",
      missionIdentifier: relation.missionIdentifier,
      missionStatus: mission?.status ?? null,
      missionMode: mission?.mode ?? null,
      projectIdentifier: relation.projectIdentifier,
      conversationIdentifier: relation.conversationIdentifier,
      sequenceIdentifier: relation.taskSequenceIdentifier,
      taskIdentifier: relation.taskIdentifier,
      sequenceOwnerAgentInstanceIdentifier:
        relation.sequenceOwnerAgentInstanceIdentifier,
      sequenceTaskStatus: sequenceTask.status,
      priorityTier: sequenceTask.priorityTier,
      sequenceOrdinal: sequenceTask.sequenceOrdinal,
      leaseExpiresAtIso: await input.ports.readLeaseExpiresAtIso(
        relation.missionIdentifier,
      ),
      labels:
        (await input.ports.readMissionLabels?.(relation.missionIdentifier)) ?? ["unknown"],
    });
  }

  if (input.ports.listSequenceTasks !== undefined) {
    const tasks = await input.ports.listSequenceTasks();
    for (const task of tasks) {
      const key = `${task.ownerAgentInstanceIdentifier}\u0000${task.sequenceIdentifier}\u0000${task.taskIdentifier}`;
      if (referencedSequenceTasks.has(key)) continue;
      views.push({
        kind: "sequence-only",
        missionIdentifier: null,
        missionStatus: null,
        missionMode: null,
        projectIdentifier: null,
        conversationIdentifier: null,
        sequenceIdentifier: task.sequenceIdentifier,
        taskIdentifier: task.taskIdentifier,
        sequenceOwnerAgentInstanceIdentifier: task.ownerAgentInstanceIdentifier,
        sequenceTaskStatus: task.status,
        priorityTier: task.priorityTier,
        sequenceOrdinal: task.sequenceOrdinal,
        leaseExpiresAtIso: null,
        labels: ["unknown"],
      });
    }
  }

  const plan = selectStartupRecoveryPlan({
    views,
    policy: input.policy,
    effectiveLimit: capacity.effectiveLimit,
    nowIso: input.nowIso,
  });
  return {
    ...plan,
    scannedAtIso: input.nowIso,
    policy: input.policy,
    capacity,
    views,
  };
}
