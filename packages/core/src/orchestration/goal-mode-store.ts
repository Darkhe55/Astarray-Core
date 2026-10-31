/**
 * GOAL-02-03（2026-10-28）：**目标模式的持久化、恢复对账与实验退出**。
 *
 * 卡内要求：
 * - 持久化目标版本、V 的逐项依据、累计预算、当前组、暂停原因；
 * - 恢复**先对账**，不重复副作用；
 * - 关闭实验后**安全停止新增目标派发**，保留已存在任务与历史，**不清除限制、不撤销已执行结果**；
 * - 返回状态、判据缺口、资源消耗与下一检查点；
 *   **禁止返回未经证实的稳定性保证**（状态里的 `stabilityGuarantee` 恒为 `"none"`）。
 *
 * 本模块落盘在 `<state>/goal-mode/<goalIdentifier>.json`（原子写 + 互斥 + 备份恢复）。
 * 它不派发、不调工具；恢复后是否继续派发由调用方按 `resumeDecision` 决定。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";
import type { GoalContract, GoalRequirementEvidence } from "./goal-contract.js";
import type { GoalGateSnapshot } from "./goal-dispatch-gate.js";

/** 持久化文档版本。 */
export const GOAL_MODE_STATE_SCHEMA_VERSION = 1;

export interface PersistedGoalRequirementBasis {
  readonly requirementIdentifier: string;
  readonly weight: number;
  readonly evidence: GoalRequirementEvidence;
  readonly remainingContribution: number;
}

export interface PersistedGoalModeState {
  readonly schemaVersion: typeof GOAL_MODE_STATE_SCHEMA_VERSION;
  readonly documentRevision: number;
  readonly goalIdentifier: string;
  readonly contractRevision: number;
  readonly ownerIdentifier: string;
  /** 原始要求引用：恢复时必须与契约一致（防止把别的目标的状态套过来）。 */
  readonly sourceRequestReference: string;
  /** V 的逐项依据（不是只有一个数字）。 */
  readonly requirementBases: readonly PersistedGoalRequirementBasis[];
  readonly lastPotentialValue: number | null;
  /** 当前组（非 null 表示恢复时需要先对账）。 */
  readonly currentTaskGroupIdentifier: string | null;
  readonly currentTaskGroupStartedAtIso: string | null;
  readonly consumedToolCalls: number;
  readonly consumedCostUnits: number;
  readonly pauseReason: string | null;
  readonly evidenceGaps: readonly string[];
  readonly requiresReplanning: boolean;
  /** 实验是否已关闭（关闭后不再新增派发，但状态与历史保留）。 */
  readonly isExperimentClosed: boolean;
  readonly closedAtIso: string | null;
  readonly gateSnapshot: GoalGateSnapshot;
  readonly updatedAtIso: string;
}

export type GoalResumeDecision =
  | {
      readonly kind: "resume";
      readonly detail: string;
      readonly lastPotentialValue: number | null;
    }
  | {
      readonly kind: "reconcile-first";
      readonly detail: string;
      readonly inFlightTaskGroupIdentifier: string;
    }
  | {
      readonly kind: "stay-paused";
      readonly detail: string;
      readonly pauseReason: string;
      readonly evidenceGaps: readonly string[];
    };

export interface GoalModeStatusView {
  readonly goalIdentifier: string;
  readonly contractRevision: number;
  readonly isExperimentClosed: boolean;
  readonly isPaused: boolean;
  readonly pauseReason: string | null;
  readonly requiresReplanning: boolean;
  readonly lastPotentialValue: number | null;
  readonly requirementBasisCount: number;
  readonly evidenceGapCount: number;
  readonly consumedToolCalls: number;
  readonly nextCheckpoint: string;
  /** **恒为 "none"**：本模块不提供、也不声称任何稳定性保证。 */
  readonly stabilityGuarantee: "none";
  readonly updatedAtIso: string;
}

export class GoalModeStateStore {
  private readonly baseDirectory: string;
  private readonly lock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.baseDirectory = path.join(options.baseDirectory, "goal-mode");
  }

  private stateFilePath(goalIdentifier: string): string {
    const sanitized = goalIdentifier.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.baseDirectory, `${sanitized}.json`);
  }

  async read(goalIdentifier: string): Promise<PersistedGoalModeState | null> {
    const filePath = this.stateFilePath(goalIdentifier);
    const readResult = await readJsonWithBackupRecovery(
      filePath,
      `${filePath}.bak`,
    );
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as Partial<PersistedGoalModeState> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      content.schemaVersion !== GOAL_MODE_STATE_SCHEMA_VERSION ||
      typeof content.goalIdentifier !== "string"
    ) {
      return null;
    }
    return content as PersistedGoalModeState;
  }

  async write(state: PersistedGoalModeState): Promise<void> {
    await this.lock.runExclusive(async () => {
      await writeAtomicJson(this.stateFilePath(state.goalIdentifier), state);
    });
  }

  /** 记录"当前组开始"（用于恢复时判断是否需要对账）。 */
  async beginTaskGroup(input: {
    readonly state: PersistedGoalModeState;
    readonly taskGroupIdentifier: string;
    readonly startedAtIso: string;
  }): Promise<PersistedGoalModeState> {
    const next: PersistedGoalModeState = {
      ...input.state,
      documentRevision: input.state.documentRevision + 1,
      currentTaskGroupIdentifier: input.taskGroupIdentifier,
      currentTaskGroupStartedAtIso: input.startedAtIso,
      updatedAtIso: input.startedAtIso,
    };
    await this.write(next);
    return next;
  }

  /** 记录"当前组已收口"（正常结束；无论成功/失败都清空在途标记）。 */
  async finishTaskGroup(input: {
    readonly state: PersistedGoalModeState;
    readonly finishedAtIso: string;
    readonly gateSnapshot: GoalGateSnapshot;
    readonly requirementBases: readonly PersistedGoalRequirementBasis[];
    readonly lastPotentialValue: number | null;
    readonly consumedToolCalls: number;
  }): Promise<PersistedGoalModeState> {
    /**
     * R86（2026-10-31）：**以磁盘上的最新状态为基线**合并，而不是覆盖。
     *
     * 组结束时可能已有并发写入（例如预算耗尽先暂停了目标、或证据失效）。
     * 用开始时读到的 `input.state` 直接覆盖，会清掉 `pauseReason`、把 `consumedToolCalls`
     * 归零、把 `requiresReplanning` 抹掉（实测：治理停止后状态回退）。
     */
    const current = (await this.read(input.state.goalIdentifier)) ?? input.state;
    const mergedEvidenceGaps = [
      ...new Set([...current.evidenceGaps, ...input.gateSnapshot.evidenceGaps]),
    ];
    const next: PersistedGoalModeState = {
      ...current,
      documentRevision: current.documentRevision + 1,
      currentTaskGroupIdentifier: null,
      currentTaskGroupStartedAtIso: null,
      gateSnapshot: {
        ...input.gateSnapshot,
        pauseReason: input.gateSnapshot.pauseReason ?? current.pauseReason,
        evidenceGaps: mergedEvidenceGaps,
        requiresReplanning:
          input.gateSnapshot.requiresReplanning || current.requiresReplanning,
        consumedToolCalls: Math.max(
          input.gateSnapshot.consumedToolCalls,
          current.consumedToolCalls,
          input.consumedToolCalls,
        ),
      },
      requirementBases: input.requirementBases,
      lastPotentialValue: input.lastPotentialValue,
      consumedToolCalls: Math.max(input.consumedToolCalls, current.consumedToolCalls),
      pauseReason: input.gateSnapshot.pauseReason ?? current.pauseReason,
      evidenceGaps: mergedEvidenceGaps,
      requiresReplanning:
        input.gateSnapshot.requiresReplanning || current.requiresReplanning,
      updatedAtIso: input.finishedAtIso,
    };
    await this.write(next);
    return next;
  }

  /**
   * 恢复前**对账**：先判断能不能恢复，不直接重跑。
   *
   * - 有在途组 ⇒ `reconcile-first`（不知道副作用是否发生，禁止直接重跑）；
   * - 暂停/需重规划 ⇒ `stay-paused`；
   * - 否则 `resume`，并带上 last-known V（不重算、不宣称稳定）。
   */
  async evaluateResume(input: {
    readonly goalIdentifier: string;
    readonly contract: GoalContract;
  }): Promise<GoalResumeDecision> {
    const state = await this.read(input.goalIdentifier);
    if (state === null) {
      return { kind: "resume", detail: "没有持久化状态：按首次运行处理。", lastPotentialValue: null };
    }
    if (state.goalIdentifier !== input.contract.goalIdentifier) {
      throw new DomainError("invalid-task-chain", "持久化目标标识与契约不一致。");
    }
    if (
      state.contractRevision !== input.contract.revision ||
      state.sourceRequestReference !== input.contract.sourceRequestReference
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "持久化状态绑定的目标版本/原始要求与当前契约不一致：不得把旧状态套到新目标。",
      );
    }
    if (state.isExperimentClosed) {
      return {
        kind: "stay-paused",
        detail: "实验已关闭：不恢复新增派发（状态与历史保留）。",
        pauseReason: "实验已关闭",
        evidenceGaps: [],
      };
    }
    if (state.currentTaskGroupIdentifier !== null) {
      return {
        kind: "reconcile-first",
        detail:
          "存在未收口的任务组：先对账副作用，禁止直接重跑（避免重复副作用）。",
        inFlightTaskGroupIdentifier: state.currentTaskGroupIdentifier,
      };
    }
    if (state.requiresReplanning || state.pauseReason !== null) {
      return {
        kind: "stay-paused",
        detail: state.pauseReason ?? "目标处于暂停状态：恢复前需重新规划。",
        pauseReason: state.pauseReason ?? "requires-replanning",
        evidenceGaps: [...state.evidenceGaps],
      };
    }
    return {
      kind: "resume",
      detail: "对账通过：没有在途组、没有暂停，按持久化预算继续。",
      lastPotentialValue: state.lastPotentialValue,
    };
  }

  /**
   * **关闭实验**：安全停止新增派发。
   *
   * 只置标记并记录时间；**保留**任务、历史、限制与已执行结果（不清空任何东西）。
   */
  async closeExperiment(input: {
    readonly goalIdentifier: string;
    readonly closedAtIso: string;
    readonly reason: string;
  }): Promise<PersistedGoalModeState> {
    const state = await this.read(input.goalIdentifier);
    if (state === null) {
      throw new DomainError("mission-not-found", "没有该目标的持久化状态。");
    }
    const next: PersistedGoalModeState = {
      ...state,
      documentRevision: state.documentRevision + 1,
      isExperimentClosed: true,
      closedAtIso: input.closedAtIso,
      pauseReason: `实验已关闭（${input.reason}）`,
      updatedAtIso: input.closedAtIso,
    };
    await this.write(next);
    return next;
  }

  /** 状态视图：返回状态、判据缺口、资源消耗、下一检查点；**不返回稳定性保证**。 */
  async describeStatus(goalIdentifier: string): Promise<GoalModeStatusView | null> {
    const state = await this.read(goalIdentifier);
    if (state === null) {
      return null;
    }
    const nextCheckpoint =
      state.currentTaskGroupIdentifier !== null
        ? `先对账在途组 ${state.currentTaskGroupIdentifier}`
        : state.isExperimentClosed
          ? "实验已关闭：无自动检查点"
          : state.requiresReplanning
            ? "重新规划后设置新检查点"
            : "下三个已结束任务组后检查一次进展";
    return {
      goalIdentifier: state.goalIdentifier,
      contractRevision: state.contractRevision,
      isExperimentClosed: state.isExperimentClosed,
      isPaused: state.pauseReason !== null,
      pauseReason: state.pauseReason,
      requiresReplanning: state.requiresReplanning,
      lastPotentialValue: state.lastPotentialValue,
      requirementBasisCount: state.requirementBases.length,
      evidenceGapCount: state.evidenceGaps.length,
      consumedToolCalls: state.consumedToolCalls,
      nextCheckpoint,
      stabilityGuarantee: "none",
      updatedAtIso: state.updatedAtIso,
    };
  }
}
