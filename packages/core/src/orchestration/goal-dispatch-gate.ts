/**
 * GOAL-02-02（2026-10-28）：**目标模式的本地门禁与有界绕行**。
 *
 * 卡内要求：
 * - 派发前验证 scope、权限、目标版本、预算；每次副作用**仍走原工具权限与备份门禁**
 *   （本门禁不替代它们，只额外检查目标一致性）。
 * - **每三个已结束任务组**检查一次进展（完成/中断都计组，不靠启动次数）；
 *   沿用现有调用总预算与截止时间，取更严边界。
 * - 允许调查、测试与必要返工**暂时不降 V**；固定版本**连续三组不下降**则暂停该目标
 *   自动派发，给出证据缺口与继续条件；**不自动无限重试**或申请额外资源。
 * - 证据失效导致 V 上升 ⇒ 保留事实、暂停、重新规划；**禁止修改权重掩盖倒退**。
 * - 模型只提出动作与解释，**本地校验器**记录执行前后状态，模型不能伪造"已执行"。
 *
 * 本模块是**进程内状态机**（不落盘：持久化属 GOAL-02-03）。
 */
import { DomainError } from "../core/errors.js";
import type { GoalContract } from "./goal-contract.js";

/** 进展检查间隔：每三个**已结束**任务组检查一次（完成/中断都计组）。 */
export const GOAL_PROGRESS_CHECK_INTERVAL_TASK_GROUPS = 3;

/** 连续多少次检查 V 未下降即暂停自动派发。 */
export const GOAL_STAGNATION_PAUSE_THRESHOLD_CHECKS = 3;

export type GoalTaskGroupOutcome = "completed" | "interrupted";

export type GoalGroupKind = "normal" | "investigation" | "rework";

export interface GoalGroupCompletionRecord {
  readonly groupIdentifier: string;
  readonly outcome: GoalTaskGroupOutcome;
  readonly groupKind: GoalGroupKind;
  /** 该组结束后的 V（由本地计算，不由模型提供）。 */
  readonly potentialValueAfterGroup: number;
  readonly recordedBy: "local-verifier";
  readonly recordedAtIso: string;
}

export type GoalDispatchVerdict =
  | {
      readonly isAllowed: true;
      readonly remainingBudget: { readonly toolCalls: number | null };
      readonly groupsUntilNextProgressCheck: number;
    }
  | {
      readonly isAllowed: false;
      readonly reasonCode:
        | "goal-paused"
        | "revision-mismatch"
        | "scope-violation"
        | "budget-exhausted"
        | "deadline-passed"
        | "requires-replanning";
      readonly detail: string;
      readonly evidenceGaps: readonly string[];
    };

export interface GoalGateState {
  readonly goalIdentifier: string;
  readonly contractRevision: number;
  readonly completedGroupCount: number;
  readonly checksSinceLastReduction: number;
  readonly lastPotentialValue: number | null;
  readonly isPaused: boolean;
  readonly pauseReason: string | null;
  readonly evidenceGaps: readonly string[];
  readonly consumedToolCalls: number;
  readonly requiresReplanning: boolean;
}

export class GoalDispatchGate {
  private completedGroupCount = 0;
  private checksSinceLastReduction = 0;
  private lastPotentialValue: number | null = null;
  private bestPotentialValue: number | null = null;
  private isPaused = false;
  private pauseReason: string | null = null;
  private evidenceGaps: string[] = [];
  private consumedToolCalls = 0;
  private requiresReplanning = false;

  constructor(private readonly contract: GoalContract) {}

  getState(): GoalGateState {
    return {
      goalIdentifier: this.contract.goalIdentifier,
      contractRevision: this.contract.revision,
      completedGroupCount: this.completedGroupCount,
      checksSinceLastReduction: this.checksSinceLastReduction,
      lastPotentialValue: this.lastPotentialValue,
      isPaused: this.isPaused,
      pauseReason: this.pauseReason,
      evidenceGaps: [...this.evidenceGaps],
      consumedToolCalls: this.consumedToolCalls,
      requiresReplanning: this.requiresReplanning,
    };
  }

  /** 暂停/恢复只能由本地控制面调用（模型无此入口）。 */
  pause(reason: string, evidenceGaps: readonly string[]): void {
    this.isPaused = true;
    this.pauseReason = reason;
    this.evidenceGaps = [...evidenceGaps];
  }

  resume(): void {
    this.isPaused = false;
    this.pauseReason = null;
    this.requiresReplanning = false;
    this.checksSinceLastReduction = 0;
  }

  /**
   * 派发前检查：scope、目标版本、预算、截止、暂停状态。
   *
   * **不替代**工具权限/备份门禁 —— 调用方仍必须走原路径。
   */
  assertDispatchAllowed(input: {
    readonly requestedContractRevision: number;
    readonly projectIdentifier: string;
    readonly toolName: string;
    readonly nowIso: string;
  }): GoalDispatchVerdict {
    if (this.isPaused) {
      return {
        isAllowed: false,
        reasonCode: "goal-paused",
        detail: this.pauseReason ?? "目标已暂停自动派发",
        evidenceGaps: [...this.evidenceGaps],
      };
    }
    if (this.requiresReplanning) {
      return {
        isAllowed: false,
        reasonCode: "requires-replanning",
        detail: "证据失效导致目标需要重新规划（禁止改权重掩盖倒退）。",
        evidenceGaps: [...this.evidenceGaps],
      };
    }
    if (input.requestedContractRevision !== this.contract.revision) {
      return {
        isAllowed: false,
        reasonCode: "revision-mismatch",
        detail: `派发请求绑定 revision ${input.requestedContractRevision}，当前为 ${this.contract.revision}。`,
        evidenceGaps: [],
      };
    }
    if (
      this.contract.scope.projectIdentifiers.length > 0 &&
      !this.contract.scope.projectIdentifiers.includes(input.projectIdentifier)
    ) {
      return {
        isAllowed: false,
        reasonCode: "scope-violation",
        detail: `项目 ${input.projectIdentifier} 不在目标范围内。`,
        evidenceGaps: [],
      };
    }
    if (
      this.contract.scope.allowedToolNames !== null &&
      !this.contract.scope.allowedToolNames.includes(input.toolName)
    ) {
      return {
        isAllowed: false,
        reasonCode: "scope-violation",
        detail: `工具 ${input.toolName} 不在目标允许范围内。`,
        evidenceGaps: [],
      };
    }
    const nowMilliseconds = Date.parse(input.nowIso);
    if (
      this.contract.deadlineIso !== null &&
      (Number.isNaN(nowMilliseconds) ||
        nowMilliseconds > Date.parse(this.contract.deadlineIso))
    ) {
      return {
        isAllowed: false,
        reasonCode: "deadline-passed",
        detail: `目标已过截止时间 ${this.contract.deadlineIso}。`,
        evidenceGaps: [],
      };
    }
    const maximumToolCalls = this.contract.resourceLimits.maximumToolCalls;
    if (maximumToolCalls !== null && this.consumedToolCalls >= maximumToolCalls) {
      return {
        isAllowed: false,
        reasonCode: "budget-exhausted",
        detail: `目标工具调用预算已用尽（${this.consumedToolCalls}/${maximumToolCalls}）。`,
        evidenceGaps: [],
      };
    }
    const groupsUntilNextCheck =
      GOAL_PROGRESS_CHECK_INTERVAL_TASK_GROUPS -
      (this.completedGroupCount % GOAL_PROGRESS_CHECK_INTERVAL_TASK_GROUPS);
    return {
      isAllowed: true,
      remainingBudget: {
        toolCalls:
          maximumToolCalls === null ? null : maximumToolCalls - this.consumedToolCalls,
      },
      groupsUntilNextProgressCheck: groupsUntilNextCheck,
    };
  }

  /** 记录一次真实工具调用消耗（由工具执行层调用，不由模型上报）。 */
  recordToolCallConsumed(count = 1): void {
    this.consumedToolCalls += count;
  }

  /**
   * 任务组结束时记录（**只接受本地校验器**的观察）。
   *
   * 每三组检查一次进展：只有"普通"组参与停滞计数；调查/返工组**暂时不降不罚**。
   */
  recordGroupCompletion(
    record: GoalGroupCompletionRecord,
  ): {
    readonly didRunProgressCheck: boolean;
    readonly checksSinceLastReduction: number;
    readonly didPause: boolean;
    readonly pauseDetail: string | null;
  } {
    if (record.recordedBy !== "local-verifier") {
      throw new DomainError(
        "task-sequence-permission-denied",
        "任务组结果只能由本地校验器记录（模型不得伪造已执行）。",
      );
    }
    this.completedGroupCount += 1;
    this.lastPotentialValue = record.potentialValueAfterGroup;
    const didReachCheckInterval =
      this.completedGroupCount % GOAL_PROGRESS_CHECK_INTERVAL_TASK_GROUPS === 0;
    if (!didReachCheckInterval) {
      return {
        didRunProgressCheck: false,
        checksSinceLastReduction: this.checksSinceLastReduction,
        didPause: this.isPaused,
        pauseDetail: this.pauseReason,
      };
    }
    /** 调查/返工组不计入停滞（允许暂时不降）。 */
    if (record.groupKind !== "normal") {
      return {
        didRunProgressCheck: true,
        checksSinceLastReduction: this.checksSinceLastReduction,
        didPause: this.isPaused,
        pauseDetail: this.pauseReason,
      };
    }
    const previousBest = this.bestPotentialValue;
    const didReduce =
      previousBest === null || record.potentialValueAfterGroup < previousBest;
    if (didReduce) {
      this.bestPotentialValue = record.potentialValueAfterGroup;
      this.checksSinceLastReduction = 0;
      return {
        didRunProgressCheck: true,
        checksSinceLastReduction: 0,
        didPause: false,
        pauseDetail: null,
      };
    }
    this.checksSinceLastReduction += 1;
    if (this.checksSinceLastReduction >= GOAL_STAGNATION_PAUSE_THRESHOLD_CHECKS) {
      this.pause(
        `固定目标版本连续 ${this.checksSinceLastReduction} 次进展检查 V 未下降：暂停自动派发。`,
        this.evidenceGaps.length > 0
          ? this.evidenceGaps
          : ["尚未给出证据缺口清单（需要重新规划或补充证据）"],
      );
      return {
        didRunProgressCheck: true,
        checksSinceLastReduction: this.checksSinceLastReduction,
        didPause: true,
        pauseDetail: this.pauseReason,
      };
    }
    return {
      didRunProgressCheck: true,
      checksSinceLastReduction: this.checksSinceLastReduction,
      didPause: false,
      pauseDetail: null,
    };
  }

  /**
   * 证据失效（外部变化/依赖被推翻）：V 上升 ⇒ 保留事实、暂停、重新规划。
   *
   * **不修改任何要求权重**（结构上没有入口），也不回滚用户修改。
   */
  recordEvidenceInvalidation(input: {
    readonly requirementIdentifiers: readonly string[];
    readonly reason: string;
    readonly potentialValueAfterInvalidation: number;
    readonly recordedAtIso: string;
  }): void {
    void input.recordedAtIso;
    this.lastPotentialValue = input.potentialValueAfterInvalidation;
    this.requiresReplanning = true;
    this.pause(
      `证据失效导致 V 上升（${input.potentialValueAfterInvalidation}）：保留事实并暂停自动派发，需重新规划。原因：${input.reason}`,
      input.requirementIdentifiers.map(
        (requirementIdentifier) =>
          `要求 ${requirementIdentifier} 的证据已失效（${input.reason}）`,
      ),
    );
  }

  /** 记录"调查/测试/返工"暂时不降 V 的窗口（不影响停滞计数）。 */
  noteNonLoweringWorkWindow(reason: string): void {
    this.evidenceGaps.push(`已记录不降窗口：${reason}`);
  }
}
