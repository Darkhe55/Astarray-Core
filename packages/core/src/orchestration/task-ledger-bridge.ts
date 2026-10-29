/**
 * 接线缺口第 ① 项（2026-10-28，第 37 轮）：**两套记账的对照桥**。
 *
 * 已知结构性缺口（ADR-0052 / ALIGN_CORE_HANDOFF §3）：
 * - 权威任务序列（`AgentTaskSequenceStore` + `TaskSequenceStatusController`）与 mission 任务链
 *   （`MissionManager` + `DagScheduler`）是**两套记账**；
 * - `MissionOrchestrator` **没有**"按 taskId 领取/派发/插入"的公开 API；
 * - `DagScheduler` 不支持运行中图变更。
 *
 * 本轮**不假装**补上派发能力：本模块只做两件事——
 * 1. **只读对照**：把两套记账的差异显式表达出来（任务只在序列/只在 mission、状态不一致）；
 * 2. **显式拒绝**：`requestDispatchByTaskIdentifier` / `requestInsertionByTaskIdentifier`
 *    返回 `refused-unsupported` 并列出缺失能力，**不做静默 no-op**、不伪造派发成功。
 *
 * 这样"差距"第一次在代码里可被表达、可被测试（后续窗口接真实派发时，用同一入口替换拒绝分支）。
 */
import { DomainError } from "../core/errors.js";
import type { ActorIdentity } from "./task-sequence-controllers.js";

export interface TaskSequenceLedgerNodeView {
  readonly taskId: string;
  readonly status: string;
}

export interface TaskSequenceLedgerPort {
  getSnapshot(input: {
    readonly ownerAgentInstanceId: string;
    readonly sequenceId: string;
    readonly viewer: ActorIdentity;
  }): Promise<{
    readonly sequenceId: string;
    readonly revision: number;
    readonly nodes: readonly TaskSequenceLedgerNodeView[];
    readonly readyTaskIds: readonly string[];
  }>;
}

export interface MissionTaskChainView {
  readonly tasks: readonly { readonly id: string; readonly status: string }[];
}

export interface MissionTaskChainPort {
  getMissionStatus(missionIdentifier: string): Promise<{
    readonly taskChain: MissionTaskChainView | null;
  }>;
}

export interface TaskLedgerAlignmentReport {
  readonly missionIdentifier: string;
  readonly sequenceId: string;
  readonly sequenceRevision: number;
  readonly sequenceTaskIdentifiers: readonly string[];
  readonly missionTaskIdentifiers: readonly string[];
  readonly tasksOnlyInSequence: readonly string[];
  readonly tasksOnlyInMission: readonly string[];
  readonly statusMismatches: readonly {
    readonly taskIdentifier: string;
    readonly sequenceStatus: string;
    readonly missionStatus: string;
  }[];
  readonly readyTaskIdentifiers: readonly string[];
  readonly divergences: readonly string[];
  /** 当前**不具备**的能力（如实列出，避免调用方误判）。 */
  readonly capabilities: {
    readonly canClaimTaskByTaskIdentifier: false;
    readonly canDispatchTaskByTaskIdentifier: false;
    readonly canInsertTaskDuringRun: false;
    readonly canMutateTaskGraph: false;
  };
}

export type TaskLedgerOperationRefusal = {
  readonly kind: "refused-unsupported";
  readonly operation: "dispatch-by-task-identifier" | "insert-by-task-identifier";
  readonly reason: string;
  readonly missingCapabilities: readonly string[];
};

export class TaskLedgerBridge {
  constructor(
    private readonly options: {
      readonly sequenceLedger: TaskSequenceLedgerPort;
      readonly missionTaskChain: MissionTaskChainPort;
    },
  ) {}

  /** 只读对照：两套记账差在哪。 */
  async inspectAlignment(input: {
    readonly missionIdentifier: string;
    readonly ownerAgentInstanceId: string;
    readonly sequenceId: string;
    readonly viewer: ActorIdentity;
  }): Promise<TaskLedgerAlignmentReport> {
    const [snapshot, missionStatus] = await Promise.all([
      this.options.sequenceLedger.getSnapshot({
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        sequenceId: input.sequenceId,
        viewer: input.viewer,
      }),
      this.options.missionTaskChain.getMissionStatus(input.missionIdentifier),
    ]);
    if (missionStatus.taskChain === null) {
      throw new DomainError(
        "mission-not-found",
        `mission ${input.missionIdentifier} 没有任务链：无法与序列对照。`,
      );
    }
    const sequenceStatusByTask = new Map(
      snapshot.nodes.map((node) => [node.taskId, node.status]),
    );
    const missionStatusByTask = new Map(
      missionStatus.taskChain.tasks.map((task) => [task.id, task.status]),
    );
    const sequenceTaskIdentifiers = [...sequenceStatusByTask.keys()].sort();
    const missionTaskIdentifiers = [...missionStatusByTask.keys()].sort();
    const tasksOnlyInSequence = sequenceTaskIdentifiers.filter(
      (taskIdentifier) => !missionStatusByTask.has(taskIdentifier),
    );
    const tasksOnlyInMission = missionTaskIdentifiers.filter(
      (taskIdentifier) => !sequenceStatusByTask.has(taskIdentifier),
    );
    const statusMismatches: {
      taskIdentifier: string;
      sequenceStatus: string;
      missionStatus: string;
    }[] = [];
    for (const taskIdentifier of sequenceTaskIdentifiers) {
      const missionTaskStatus = missionStatusByTask.get(taskIdentifier);
      if (missionStatusByTask.has(taskIdentifier) && missionTaskStatus !== undefined) {
        const sequenceTaskStatus = sequenceStatusByTask.get(taskIdentifier) ?? "";
        if (sequenceTaskStatus !== missionTaskStatus) {
          statusMismatches.push({
            taskIdentifier,
            sequenceStatus: sequenceTaskStatus,
            missionStatus: missionTaskStatus,
          });
        }
      }
    }
    const divergences: string[] = [];
    if (tasksOnlyInSequence.length > 0) {
      divergences.push(
        `只在权威序列中的任务（mission 链里没有）: ${tasksOnlyInSequence.join(", ")}`,
      );
    }
    if (tasksOnlyInMission.length > 0) {
      divergences.push(
        `只在 mission 链中的任务（权威序列里没有）: ${tasksOnlyInMission.join(", ")}`,
      );
    }
    if (statusMismatches.length > 0) {
      divergences.push(
        "状态不一致: " +
          statusMismatches
            .map(
              (mismatch) =>
                `${mismatch.taskIdentifier}(序列=${mismatch.sequenceStatus}, mission=${mismatch.missionStatus})`,
            )
            .join("; "),
      );
    }
    return {
      missionIdentifier: input.missionIdentifier,
      sequenceId: snapshot.sequenceId,
      sequenceRevision: snapshot.revision,
      sequenceTaskIdentifiers,
      missionTaskIdentifiers,
      tasksOnlyInSequence,
      tasksOnlyInMission,
      statusMismatches,
      readyTaskIdentifiers: [...snapshot.readyTaskIds],
      divergences,
      capabilities: {
        canClaimTaskByTaskIdentifier: false,
        canDispatchTaskByTaskIdentifier: false,
        canInsertTaskDuringRun: false,
        canMutateTaskGraph: false,
      },
    };
  }

  /**
   * R23（2026-10-29）：**单任务派发的只读预检**。
   *
   * 只回答"按现有两套记账看，这个任务能不能被单独派发、缺什么"，**不改任何状态、不派发**。
   * 预检通过**不等于**可以派发：编排层仍没有按 taskId 的领取/派发 API（见 capabilities）。
   */
  async inspectSingleTaskDispatchPrecheck(input: {
    readonly missionIdentifier: string;
    readonly taskIdentifier: string;
    readonly ownerAgentInstanceId: string;
    readonly sequenceId: string;
    readonly viewer: ActorIdentity;
  }): Promise<{
    readonly missionIdentifier: string;
    readonly sequenceId: string;
    readonly sequenceRevision: number;
    readonly taskIdentifier: string;
    readonly isDispatchable: boolean;
    readonly blockedReasons: readonly string[];
    readonly sequenceStatus: string | null;
    readonly missionStatus: string | null;
    readonly capabilities: {
      readonly canDispatchTaskByTaskIdentifier: false;
      readonly note: string;
    };
  }> {
    const [snapshot, missionStatus] = await Promise.all([
      this.options.sequenceLedger.getSnapshot({
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        sequenceId: input.sequenceId,
        viewer: input.viewer,
      }),
      this.options.missionTaskChain.getMissionStatus(input.missionIdentifier),
    ]);
    if (missionStatus.taskChain === null) {
      throw new DomainError(
        "mission-not-found",
        `mission ${input.missionIdentifier} 没有任务链：无法做单任务派发预检。`,
      );
    }
    const sequenceNode =
      snapshot.nodes.find((node) => node.taskId === input.taskIdentifier) ?? null;
    const missionTask =
      missionStatus.taskChain.tasks.find((task) => task.id === input.taskIdentifier) ??
      null;
    const blockedReasons: string[] = [];
    if (sequenceNode === null) {
      blockedReasons.push("任务不在权威序列中（序列侧没有这个任务）");
    }
    if (missionTask === null) {
      blockedReasons.push("任务不在 mission 任务链中");
    }
    if (
      sequenceNode !== null &&
      missionTask !== null &&
      sequenceNode.status !== missionTask.status
    ) {
      blockedReasons.push(
        `两套记账状态不一致（序列=${sequenceNode.status}, mission=${missionTask.status}）：先对账再派发`,
      );
    }
    if (
      sequenceNode !== null &&
      !snapshot.readyTaskIds.includes(input.taskIdentifier)
    ) {
      blockedReasons.push("序列侧判定为未 ready（依赖未满足或状态不是 pending）");
    }
    if (missionTask !== null && missionTask.status !== "pending") {
      blockedReasons.push(
        `mission 侧状态为 ${missionTask.status}，不是可派发的 pending`,
      );
    }
    return {
      missionIdentifier: input.missionIdentifier,
      sequenceId: snapshot.sequenceId,
      sequenceRevision: snapshot.revision,
      taskIdentifier: input.taskIdentifier,
      isDispatchable: blockedReasons.length === 0,
      blockedReasons,
      sequenceStatus: sequenceNode?.status ?? null,
      missionStatus: missionTask?.status ?? null,
      capabilities: {
        canDispatchTaskByTaskIdentifier: false,
        note: "预检通过不等于可派发：编排层仍没有按 taskId 的领取/派发 API。",
      },
    };
  }

  /**
   * 按 taskId 派发：**当前不支持**，显式拒绝。
   *
   * 不返回"已派发"，也不做静默 no-op —— 调用方必须看到缺失能力清单。
   */
  requestDispatchByTaskIdentifier(input: {
    readonly missionIdentifier: string;
    readonly taskIdentifier: string;
  }): TaskLedgerOperationRefusal {
    return {
      kind: "refused-unsupported",
      operation: "dispatch-by-task-identifier",
      reason:
        `按 taskId 派发尚未实现（mission ${input.missionIdentifier} / task ${input.taskIdentifier}）：` +
        "MissionOrchestrator 目前只按 DagScheduler 的轮次整体调度，没有单个任务的领取/派发入口。",
      missingCapabilities: [
        "MissionOrchestrator.claimTaskByTaskIdentifier",
        "DagScheduler 单任务派发（不改动整体轮次）",
        "权威序列 → mission 任务链的写入回同步（保持单一口径）",
      ],
    };
  }

  /** 运行中插入：**当前不支持**，显式拒绝。 */
  requestInsertionByTaskIdentifier(input: {
    readonly missionIdentifier: string;
    readonly taskIdentifier: string;
  }): TaskLedgerOperationRefusal {
    return {
      kind: "refused-unsupported",
      operation: "insert-by-task-identifier",
      reason:
        `运行中插入尚未实现（mission ${input.missionIdentifier} / task ${input.taskIdentifier}）：` +
        "DagScheduler 不支持运行中图变更，序列插入目前只能推迟到下一组。",
      missingCapabilities: [
        "DagScheduler 运行中图变更（增节点/改依赖并重算 ready set）",
        "MissionOrchestrator 对运行中调度器的任务注入入口",
        "插入后的 revision 一致性与在途任务隔离",
      ],
    };
  }
}
