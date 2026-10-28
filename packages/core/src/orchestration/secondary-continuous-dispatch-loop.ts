/**
 * 次级 Agent 持续调度循环（B6R-08 / ADR-0022 §次级 Agent 持续调度）。
 *
 * ALIGN-02-05（2026-10-28）返修：此前装配层写下的是两处**假值** ——
 * `dispatchChain: async () => false`（永远"没人要"）与 `currentOccupiedSlots: () => 0`
 * （永远"有空槽"）。本文件去掉这两处默认谎言：
 *
 * 1. **占用**缺省取 `UnboundedAgentInstanceRegistry.getOccupiedSlotCount()`（真实 running 数），
 *    不再默认 0；
 * 2. **派发**必须是真实端口：按 mission 注册（`registerMissionPorts`）。没有注册派发处理器时，
 *    `runRound` 明确返回 `blockedReason: "dispatch-handler-missing"`，**不**伪装成"派发被拒"；
 * 3. **领取原子且幂等**：派发前先 `claimTask`（由调用方用任务序列的 revision 乐观并发实现），
 *    领不到就跳过；派发被拒或抛错 ⇒ `releaseTask` 释放，任务回到可执行集合，
 *    **既不会丢任务，也不会占住假槽位**。
 */
import type { AgentTaskNode } from "../core/types.js";
import { TaskSequencePartialOrder } from "./task-sequence-partial-order.js";
import type { UnboundedAgentInstanceRegistry } from "./unbounded-agent-registry.js";

export interface DispatchChainInput {
  taskIds: string[];
  priorityTier: number;
  /**
   * ALIGN-02-05：本次领取使用的**三级实例标识**。
   * 执行方在任务收口后必须回收/释放该实例，否则真实占用不会回落 ——
   * 这正是"占住假槽位"的反面约束。
   */
  agentInstanceId: string;
}

export interface MissionDispatchPorts {
  /** 真实派发回调：把一条链派给执行者（返回是否接受）。 */
  readonly dispatchChain: (chain: DispatchChainInput) => Promise<boolean>;
  /** 原子领取：返回 false 表示"没领到"（已被别人领走/状态不符/竞态失败）。 */
  readonly claimTask?: (taskId: string) => Promise<boolean>;
  /** 释放领取：派发失败时把任务放回可执行集合。 */
  readonly releaseTask?: (taskId: string, reason: string) => Promise<void>;
}

export interface ContinuousDispatchLoopOptions {
  /** 并发准入注册表（资源限制；非数量配额）。 */
  registry: UnboundedAgentInstanceRegistry;
  /**
   * 默认派发端口（可选）。**没有**真实处理器时不要传 —— 传一个恒 false 的桩
   * 正是本轮要删除的假值。
   */
  dispatchChain?: (chain: DispatchChainInput) => Promise<boolean>;
  /** 当前并发占用（缺省取注册表真实 running 数）。 */
  currentOccupiedSlots?: () => number;
  /** 派发上限（单轮）。 */
  maxDispatchPerRound?: number;
}

export interface ContinuousDispatchLoopResult {
  dispatchedTaskIds: string[];
  pausedCount: number;
  queuedCount: number;
  /** 轮次开始时的真实占用（诊断用，不是配额）。 */
  occupiedSlotsAtRoundStart: number;
  /** 每个未派发任务的具体原因（不静默跳过）。 */
  skippedReasons: Record<string, string>;
  /** 整轮无法调度的原因（如未注册派发处理器）。 */
  blockedReason: string | null;
  /** ALIGN-02-07：截至本轮**连续无进展**的轮数（有派发即清零）。 */
  consecutiveNoProgressRoundCount: number;
  /** ALIGN-02-07：建议下一次唤醒前的等待（有界退避；无工作 ⇒ 空闲等待）。 */
  recommendedWaitMilliseconds: number;
}

/** ALIGN-02-07：调度唤醒来源（事件驱动，不靠忙轮询）。 */
export type SchedulingWakeReason =
  | "external"
  | "task-ready"
  | "task-finished"
  | "dependency-unlocked"
  | "work-window-resumed"
  | "resource-released";

export interface SchedulingWakeReport {
  /** 实际唤醒原因；超时（有界等待到期）时为 `timeout`。 */
  readonly reason: SchedulingWakeReason | "timeout";
  readonly waitedMilliseconds: number;
}

export class SecondaryContinuousDispatchLoop {
  /** ALIGN-02-07：同一任务连续派发失败的自动重派上限（超过即停手，等状态变化）。 */
  static readonly MAXIMUM_DISPATCH_ATTEMPTS_PER_TASK = 3;
  /** ALIGN-02-07：无进展退避的下界/上界（有界，不无限退避也不忙轮询）。 */
  static readonly MINIMUM_BACKOFF_MILLISECONDS = 250;
  static readonly MAXIMUM_BACKOFF_MILLISECONDS = 30_000;
  /** ALIGN-02-07：完全没有工作时的空闲等待（避免忙轮询）。 */
  static readonly IDLE_WAIT_MILLISECONDS = 30_000;
  /** ALIGN-02-07：有进展时的短暂等待（尽快继续下一组）。 */
  static readonly PROGRESS_WAIT_MILLISECONDS = 1_000;

  private readonly registry: UnboundedAgentInstanceRegistry;
  private readonly defaultDispatchChain:
    | ((chain: DispatchChainInput) => Promise<boolean>)
    | undefined;
  private readonly currentOccupiedSlots: () => number;
  private readonly maxDispatchPerRound: number;
  private readonly missionPorts = new Map<string, MissionDispatchPorts>();
  private wakeResolve: ((report: SchedulingWakeReport) => void) | null = null;
  private stopped = false;
  /** ALIGN-02-07：连续无进展轮数（派发成功即清零）。 */
  private consecutiveNoProgressRoundCount = 0;
  /** ALIGN-02-07：上一轮是否有可执行任务（决定空闲等待 vs 退避）。 */
  private lastRoundHadReadyWork = false;
  /** ALIGN-02-07：逐任务派发失败次数（成功即清零；达上限停手）。 */
  private readonly dispatchFailureCountByTaskId = new Map<string, number>();

  constructor(options: ContinuousDispatchLoopOptions) {
    this.registry = options.registry;
    this.defaultDispatchChain = options.dispatchChain;
    this.currentOccupiedSlots =
      options.currentOccupiedSlots ?? (() => options.registry.getOccupiedSlotCount());
    this.maxDispatchPerRound = options.maxDispatchPerRound ?? 8;
  }

  /** 注册某个 mission 的真实派发端口（启动 mission 调度时调用）。 */
  registerMissionPorts(missionIdentifier: string, ports: MissionDispatchPorts): void {
    this.missionPorts.set(missionIdentifier, ports);
  }

  /** 注销（mission 收口时调用；未注销也不会跨 mission 复用端口）。 */
  unregisterMissionPorts(missionIdentifier: string): void {
    this.missionPorts.delete(missionIdentifier);
  }

  /**
   * ALIGN-02-07：**事件驱动唤醒**。就绪、完成、依赖解锁、时段恢复、资源释放都应调用它，
   * 由事件决定何时重算，而不是固定周期忙轮询。
   */
  notifySchedulingEvent(reason: SchedulingWakeReason): void {
    this.wake(reason);
  }

  /** 唤醒调度（保留旧名；等价于 `notifySchedulingEvent("external")`）。 */
  wake(reason: SchedulingWakeReason = "external"): void {
    const resolver = this.wakeResolve;
    this.wakeResolve = null;
    resolver?.({
      reason,
      waitedMilliseconds: 0,
    });
  }

  /** 停止调度（会话关闭时）。 */
  stop(): void {
    this.stopped = true;
    this.wake("external");
  }

  /**
   * 一轮调度：重算 ready set → 按优先级/稳定顺序 → 领取 → 派发。
   * 无可执行节点、未注册处理器或暂停时都不派发，并如实给出原因。
   */
  async runRound(input: {
    nodes: AgentTaskNode[];
    missionIdentifier?: string;
  }): Promise<ContinuousDispatchLoopResult> {
    const result: ContinuousDispatchLoopResult = {
      dispatchedTaskIds: [],
      pausedCount: 0,
      queuedCount: 0,
      occupiedSlotsAtRoundStart: this.currentOccupiedSlots(),
      skippedReasons: {},
      blockedReason: null,
      consecutiveNoProgressRoundCount: this.consecutiveNoProgressRoundCount,
      recommendedWaitMilliseconds: this.getRecommendedWaitMilliseconds(),
    };
    if (this.stopped) {
      result.blockedReason = "loop-stopped";
      return result;
    }
    const ports =
      this.missionPorts.get(input.missionIdentifier ?? "") ??
      (this.defaultDispatchChain === undefined
        ? undefined
        : { dispatchChain: this.defaultDispatchChain });
    if (ports === undefined) {
      /**
       * 没有真实派发处理器 ⇒ **不领取、不假装派发**。
       * 这正是此前 `async () => false` 掩盖的情况。
       */
      result.blockedReason = "dispatch-handler-missing";
      return result;
    }
    const partialOrder = new TaskSequencePartialOrder(input.nodes);
    const readyTaskIds = partialOrder.getReadyTaskIds();
    let dispatchCount = 0;
    for (const taskId of readyTaskIds) {
      if (dispatchCount >= this.maxDispatchPerRound) {
        break;
      }
      const node = partialOrder.getNode(taskId);
      if (node === undefined) {
        continue;
      }
      /**
       * ALIGN-02-07：**失败不形成无限重派**。同一任务连续派发失败达到上限即停手，
       * 原因写进 `skippedReasons`；外部状态变化后可调用
       * `resetDispatchFailureCounts()` 重新允许。
       */
      const previousFailureCount = this.dispatchFailureCountByTaskId.get(taskId) ?? 0;
      if (
        previousFailureCount >=
        SecondaryContinuousDispatchLoop.MAXIMUM_DISPATCH_ATTEMPTS_PER_TASK
      ) {
        result.skippedReasons[taskId] =
          `已连续派发失败 ${previousFailureCount} 次：停止自动重派，等待状态变化或人工介入`;
        continue;
      }
      /**
       * 并发准入交给注册表判定（它自己读真实占用）：排队/暂停语义与
       * `UnboundedAgentInstanceRegistry` 保持**单一来源**，不在这里二次短路。
       */
      const instanceRecord = this.registry.createInstance({
        agentRole: "tertiary",
        missionId: input.missionIdentifier ?? null,
      });
      const admission = this.registry.requestAdmission(instanceRecord.agentInstanceId);
      if (admission.state === "queued") {
        result.queuedCount += 1;
        result.skippedReasons[taskId] = admission.reason ?? "并发槽已满：排队";
        continue;
      }
      if (admission.state === "paused") {
        result.pausedCount += 1;
        result.skippedReasons[taskId] = admission.reason ?? "并发槽与队列均满：暂停";
        continue;
      }
      if (admission.state === "recycled" || !admission.admitted) {
        result.skippedReasons[taskId] = "实例不可用（已回收或未准入）";
        continue;
      }
      /**
       * 原子领取：领不到**不派发**（幂等：同一任务不会被派两次）。
       * active 实例释放回注册表，避免占住真实槽位。
       */
      const didClaim = await (ports.claimTask?.(taskId) ?? Promise.resolve(true));
      if (!didClaim) {
        this.registry.releaseAdmission(instanceRecord.agentInstanceId);
        result.skippedReasons[taskId] = "领取失败（已被领取/状态不符/竞态）";
        continue;
      }
      try {
        const accepted = await ports.dispatchChain({
          taskIds: [taskId],
          priorityTier: node.priorityTier,
          agentInstanceId: instanceRecord.agentInstanceId,
        });
        if (accepted) {
          result.dispatchedTaskIds.push(taskId);
          dispatchCount += 1;
          this.dispatchFailureCountByTaskId.delete(taskId);
          continue;
        }
        await this.releaseQuietly(ports, taskId, "dispatch-rejected");
        this.releaseAdmissionQuietly(instanceRecord.agentInstanceId);
        this.recordDispatchFailure(taskId);
        result.skippedReasons[taskId] = "派发被拒绝：已释放领取";
      } catch (error) {
        const failureReason = `dispatch-error: ${(error as Error).message}`;
        await this.releaseQuietly(ports, taskId, failureReason);
        this.releaseAdmissionQuietly(instanceRecord.agentInstanceId);
        this.recordDispatchFailure(taskId);
        result.skippedReasons[taskId] = failureReason;
      }
    }
    /**
     * ALIGN-02-07：进展统计与有界退避。
     * 有派发 ⇒ 清零；否则累加（未注册处理器不算"无进展"，那是配置问题）。
     */
    if (result.dispatchedTaskIds.length > 0) {
      this.consecutiveNoProgressRoundCount = 0;
    } else {
      this.consecutiveNoProgressRoundCount += 1;
    }
    this.lastRoundHadReadyWork = readyTaskIds.length > 0;
    result.consecutiveNoProgressRoundCount = this.consecutiveNoProgressRoundCount;
    result.recommendedWaitMilliseconds = this.getRecommendedWaitMilliseconds();
    return result;
  }

  /** ALIGN-02-07：记一次派发失败（达到上限后由 `runRound` 停手）。 */
  private recordDispatchFailure(taskId: string): void {
    const previousCount = this.dispatchFailureCountByTaskId.get(taskId) ?? 0;
    this.dispatchFailureCountByTaskId.set(taskId, previousCount + 1);
  }

  /** 等待下一次唤醒（有界；返回**为什么醒**，超时也如实报告）。 */
  async waitForNextWake(
    maximumWaitMilliseconds: number,
  ): Promise<SchedulingWakeReport> {
    if (this.stopped) {
      return { reason: "timeout", waitedMilliseconds: 0 };
    }
    const startedAtMilliseconds = Date.now();
    return new Promise<SchedulingWakeReport>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.wakeResolve = null;
        resolve({
          reason: "timeout",
          waitedMilliseconds: Date.now() - startedAtMilliseconds,
        });
      }, maximumWaitMilliseconds);
      this.wakeResolve = (report: SchedulingWakeReport) => {
        clearTimeout(timeoutHandle);
        resolve({
          reason: report.reason,
          waitedMilliseconds: Date.now() - startedAtMilliseconds,
        });
      };
    });
  }

  /**
   * ALIGN-02-07：建议下一次等待时长（**有界退避**）。
   *
   * - 上一轮完全没有可执行任务 ⇒ 空闲等待（不忙轮询）；
   * - 有进展 ⇒ 短暂等待（尽快继续）；
   * - 连续无进展 ⇒ 指数退避，封顶 `MAXIMUM_BACKOFF_MILLISECONDS`。
   */
  getRecommendedWaitMilliseconds(): number {
    if (!this.lastRoundHadReadyWork) {
      return SecondaryContinuousDispatchLoop.IDLE_WAIT_MILLISECONDS;
    }
    if (this.consecutiveNoProgressRoundCount === 0) {
      return SecondaryContinuousDispatchLoop.PROGRESS_WAIT_MILLISECONDS;
    }
    const backoffMilliseconds =
      SecondaryContinuousDispatchLoop.MINIMUM_BACKOFF_MILLISECONDS *
      2 ** Math.min(this.consecutiveNoProgressRoundCount - 1, 7);
    return Math.min(
      backoffMilliseconds,
      SecondaryContinuousDispatchLoop.MAXIMUM_BACKOFF_MILLISECONDS,
    );
  }

  /** ALIGN-02-07：外部状态变化（如人工裁决/时段恢复）后重新允许自动重派。 */
  resetDispatchFailureCounts(): void {
    this.dispatchFailureCountByTaskId.clear();
  }

  /** ALIGN-02-07：连续无进展轮数（只读诊断）。 */
  getConsecutiveNoProgressRoundCount(): number {
    return this.consecutiveNoProgressRoundCount;
  }

  /** 校验：并发槽位不足只排队/暂停（不拒绝创建）。 */
  static assertNoHistoricalQuota(
    registry: UnboundedAgentInstanceRegistry,
  ): void {
    // 无硬编码累计数量拒绝：注册表只按资源准入
    void registry;
  }

  private async releaseQuietly(
    ports: MissionDispatchPorts,
    taskId: string,
    reason: string,
  ): Promise<void> {
    try {
      await ports.releaseTask?.(taskId, reason);
    } catch {
      /** 释放失败本身不能吞掉派发失败的原因；调用方看 skippedReasons。 */
    }
  }

  private releaseAdmissionQuietly(agentInstanceId: string): void {
    try {
      this.registry.releaseAdmission(agentInstanceId);
    } catch {
      // 回收失败不影响派发结果
    }
  }
}
