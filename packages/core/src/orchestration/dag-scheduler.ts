/**
 * DAG 调度器（T05）。
 * 职责：并发限制、任务领取锁、失败传播、blocked/retry/cancel/reassign、
 *       每轮调度后原子更新 task chain。
 */
import { TASK_CHAIN_SCHEMA_VERSION } from "../core/types.js";
import { DomainError } from "../core/errors.js";
import type { TaskChainDocument, TaskDependencyNode } from "../core/types.js";
import type { TaskStorePort } from "../core/types.js";
import { TaskGraph } from "../core/task-graph.js";

export type ScheduleAction =
  | { action: "start-task"; taskId: string; assignedAgentId: string }
  | { action: "block-task"; taskId: string; reason: string }
  | { action: "retry-task"; taskId: string }
  | { action: "reassign-task"; taskId: string; assignedAgentId: string }
  | { action: "complete-mission" };

export interface DagSchedulerOptions {
  concurrency: number;
  taskStore: TaskStorePort;
  /** 为新领取的任务分配 Worker（Agent）实例 ID。 */
  allocateAgentId: (taskId: string) => string;
}

export class DagScheduler {
  private readonly claimedTaskIds = new Set<string>();
  /**
   * R126（2026-11-01）：**按 taskId 优先派发**。
   *
   * 只影响**可运行任务之间的顺序**：不绕过依赖、不改图、不允许运行中改图。
   * 下一个调度轮次优先启动这些任务；启动后从集合移除。
   */
  private readonly preferredDispatchTaskIds = new Set<string>();
  /**
   * R128（2026-11-01）：**显式乱序派发**（用户确认"不等依赖"）。
   *
   * 只允许用户/宿主显式请求；启动不改变依赖边，只是让该任务先跑。
   * 风险由调用方承担（任务可能在依赖产出尚未就绪时运行）。
   */
  private readonly forcedDispatchTaskIds = new Set<string>();
  private readonly graph: TaskGraph;
  private readonly concurrency: number;
  private readonly missionId: string;

  constructor(
    initialChain: TaskChainDocument,
    private readonly options: DagSchedulerOptions,
  ) {
    this.graph = TaskGraph.fromTaskChain(initialChain);
    this.concurrency = options.concurrency;
    this.missionId = initialChain.missionId;
  }

  getCurrentGraph(): TaskGraph {
    return this.graph;
  }

  isTaskClaimed(taskId: string): boolean {
    return this.claimedTaskIds.has(taskId);
  }

  getRunningTaskCount(): number {
    return this.claimedTaskIds.size;
  }

  /**
   * 一轮调度：先处理外部状态回写（done/failed/blocked 等已由 Worker 完成
   * 并通过 markTaskFinished 回写），再启动可运行任务。
   * 返回本轮产生的调度动作。每个动作应被调用方执行（如通知 Worker）。
   */
  async scheduleRound(): Promise<ScheduleAction[]> {
    const actions: ScheduleAction[] = [];
    this.collectDownstreamBlocks(actions);
    if (this.graph.isMissionComplete()) {
      actions.push({ action: "complete-mission" });
      return actions;
    }
    const availableSlots = this.concurrency - this.claimedTaskIds.size;
    if (availableSlots <= 0) {
      return actions;
    }
    /** R128：显式乱序派发优先（即使依赖未完成）。 */
    const forcedTaskIds = [...this.forcedDispatchTaskIds]
      .filter((taskId) => {
        const node = this.graph.getNode(taskId);
        return (
          node !== undefined &&
          node.status === "pending" &&
          !this.claimedTaskIds.has(taskId)
        );
      })
      .slice(0, availableSlots);
    for (const taskId of forcedTaskIds) {
      this.forcedDispatchTaskIds.delete(taskId);
      this.preferredDispatchTaskIds.delete(taskId);
    }
    const remainingSlots = availableSlots - forcedTaskIds.length;
    const runnableTaskIds = [
      ...forcedTaskIds,
      ...this.graph
        .findRunnableTaskIds()
        .filter(
          (taskId) =>
            !this.claimedTaskIds.has(taskId) && !forcedTaskIds.includes(taskId),
        )
        .sort((left, right) => {
          const leftPreferred = this.preferredDispatchTaskIds.has(left) ? 0 : 1;
          const rightPreferred = this.preferredDispatchTaskIds.has(right) ? 0 : 1;
          return leftPreferred - rightPreferred;
        })
        .slice(0, remainingSlots),
    ];
    for (const taskId of runnableTaskIds) {
      const assignedAgentId = this.options.allocateAgentId(taskId);
      this.claimedTaskIds.add(taskId);
      this.graph.markRunning(taskId);
      this.graph.assignAgent(taskId, assignedAgentId);
      this.preferredDispatchTaskIds.delete(taskId);
      actions.push({ action: "start-task", taskId, assignedAgentId });
    }
    if (actions.length > 0) {
      await this.persistChain();
    }
    return actions;
  }

  /** Worker 完成任务后回写：成功或失败，并释放领取锁。 */
  async finishTask(
    taskId: string,
    outcome: "done" | "failed",
    resultLocation: string | null,
  ): Promise<void> {
    if (!this.claimedTaskIds.has(taskId)) {
      // 任务已被取消/重新指派等路径结算：视为过期结果，幂等忽略
      return;
    }
    this.claimedTaskIds.delete(taskId);
    if (outcome === "done") {
      this.graph.markDone(taskId, resultLocation);
    } else {
      this.graph.markFailed(taskId);
      this.graph.propagateFailureToDownstream(taskId);
    }
    await this.persistChain();
  }

  /** Worker 报告无法继续（如模糊/等待人工）：任务回 pending，释放锁。 */
  async releaseTaskBackToPending(taskId: string): Promise<void> {
    this.claimedTaskIds.delete(taskId);
    this.graph.markPendingForRetry(taskId);
    await this.persistChain();
  }

  /**
   * 任务进入 blocked 等待人工裁决（如 permission-ask），
   * 不会自动重新调度；裁决后经 unblockTask 恢复。
   */
  async blockTaskForHumanDecision(taskId: string): Promise<void> {
    this.claimedTaskIds.delete(taskId);
    this.graph.markBlocked(taskId);
    await this.persistChain();
  }

  /** 取消：释放锁并将任务置为 pending（由人工裁决后决定 retry/reassign）。 */
  async cancelTask(taskId: string): Promise<void> {
    this.claimedTaskIds.delete(taskId);
    this.graph.markPendingForRetry(taskId);
    await this.persistChain();
  }

  async reassignTask(taskId: string): Promise<ScheduleAction> {
    if (this.claimedTaskIds.has(taskId)) {
      this.claimedTaskIds.delete(taskId);
    }
    this.graph.markPendingForRetry(taskId);
    const assignedAgentId = this.options.allocateAgentId(taskId);
    this.graph.assignAgent(taskId, assignedAgentId);
    await this.persistChain();
    return { action: "reassign-task", taskId, assignedAgentId };
  }

  /**
   * 阻塞等待人工裁决的任务重新进入可运行集合。
   *
   * **2026-10-10 Linux 平台证据修复：迟到的 unblock 不得降级正在运行/已终态的任务。**
   *
   * 缺陷（`authorization-retry-closure` ① 在 WSL Ubuntu 上失败、Windows 上一直通过）：
   * 批准后的 `unblock` 指令是**异步**送达本调度器的，而调度循环可能已经**抢先**
   * 把任务重新领取并标记为 `running`。此前本方法只判 `pending`，否则一律
   * `markPendingForRetry` ⇒ 把**正在运行**的任务**降回 pending**，而领取集合并未释放。
   * 于是 worker 成功回写时 `finishTask("done")` 面对的是 `pending` 节点 ⇒
   * `非法状态迁移: <task> pending → done` ⇒ **成果已落盘却被误判为 blocked**。
   *
   * **不**放宽状态机（`pending → done` 必须继续非法，由
   * `tests/core/unit/task-graph-gaps.test.ts` 钉住），而是把本方法**幂等化**：
   * 只有 `pending`（已是目标态）与 `blocked`（真正等待裁决）才需要处理；
   * `running`/`done`/`failed` 下这是**冗余的迟到指令**，必须无操作。
   */
  async unblockTask(taskId: string): Promise<void> {
    const node = this.graph.getNode(taskId);
    const status = node?.status;
    /**
     * `pending` ⇒ 已是可运行态（幂等无操作）。
     * `running` ⇒ 重跑**已经在进行中**：降回 pending 会让"领取集合含此任务"
     *   与"图节点 pending"不一致，直接导致 `pending → done` 非法（见方法注释）。
     * `done`/`failed` ⇒ 已结案：不得复活，也不得把终态改回可运行。
     */
    if (
      status === "pending" ||
      status === "running" ||
      status === "done" ||
      status === "failed"
    ) {
      return;
    }
    this.graph.markPendingForRetry(taskId);
    await this.persistChain();
  }

  private collectDownstreamBlocks(actions: ScheduleAction[]): void {
    // 传播已在 finishTask 内完成；此处仅将 pending→blocked 的变更产出动作提示
    for (const taskId of this.graph.getTaskIds()) {
      const node = this.graph.getNode(taskId);
      if (node?.status === "blocked") {
        actions.push({ action: "block-task", taskId, reason: "上游任务失败" });
      }
    }
  }

  /**
   * 清单第 ① 项下半场（2026-10-28）：**安全点注入**。
   *
   * 只在没有在途任务时允许（否则调用方必须推迟到下一组）：
   * 追加到内存图 → 原子写回任务链（revision +1）。
   * 依赖必须已存在；重复 ID 直接拒绝。
   */
  /**
   * R129（2026-11-02）：**运行中修订 pending 任务的描述/工具**（安全点、只改内容）。
   *
   * 边界（刻意保守）：
   * - 只允许 `pending` 任务：运行中/终态任务不能"改需求"；
   * - 只改 `description` / `toolNames`（不改 id、依赖、状态、图结构）；
   * - 必须有在途任务=0 之外的任何时刻都可以（内容修改不影响正在跑的任务，
   *   但为了让模型下一轮读到一致内容，仍要求任务尚未启动）。
   */
  async revisePendingTask(
    taskId: string,
    patch: {
      readonly description?: string;
      readonly toolNames?: readonly string[];
    },
  ): Promise<{
    readonly outcome: "revised" | "refused";
    readonly reasonCode: string;
    readonly reason: string;
  }> {
    const node = this.graph.getNode(taskId);
    if (node === undefined) {
      return {
        outcome: "refused",
        reasonCode: "task-not-found",
        reason: `任务 ${taskId} 不在任务链中。`,
      };
    }
    if (node.status !== "pending") {
      return {
        outcome: "refused",
        reasonCode: "task-not-pending",
        reason: `任务 ${taskId} 当前状态为 ${node.status}：只能修订 pending 任务。`,
      };
    }
    if (
      patch.description === undefined &&
      patch.toolNames === undefined
    ) {
      return {
        outcome: "refused",
        reasonCode: "empty-patch",
        reason: "没有需要修订的字段（description/toolNames 至少给一个）。",
      };
    }
    if (
      patch.description !== undefined &&
      patch.description.trim() === ""
    ) {
      return {
        outcome: "refused",
        reasonCode: "invalid-patch",
        reason: "description 不能改成空字符串。",
      };
    }
    if (patch.description !== undefined) {
      node.description = patch.description;
    }
    if (patch.toolNames !== undefined) {
      node.toolNames = [...patch.toolNames];
    }
    await this.persistChain();
    return {
      outcome: "revised",
      reasonCode: "revised",
      reason: `任务 ${taskId} 已修订（下一次派发使用新内容）。`,
    };
  }
  async injectTask(node: TaskDependencyNode): Promise<void> {
    if (this.claimedTaskIds.size > 0) {
      throw new DomainError(
        "invalid-task-chain",
        "有在途任务：当前不是安全点，不能在此时注入（应推迟到下一组）。",
      );
    }
    this.graph.addNode(node);
    await this.persistChain();
  }

  /**
   * R130（2026-11-02）：**安全点注入（判定式）**——把异常转成明确拒绝。
   */
  async injectTaskChecked(node: TaskDependencyNode): Promise<{
    readonly outcome: "injected" | "refused";
    readonly reasonCode: string;
    readonly reason: string;
  }> {
    if (this.claimedTaskIds.size > 0) {
      return {
        outcome: "refused",
        reasonCode: "not-safe-point",
        reason: "有在途任务：当前不是安全点，不能注入（应推迟到下一组）。",
      };
    }
    try {
      await this.injectTask(node);
      return {
        outcome: "injected",
        reasonCode: "injected",
        reason: `任务 ${node.id} 已注入（下一次调度可运行）。`,
      };
    } catch (error) {
      return {
        outcome: "refused",
        reasonCode: "invalid-task-chain",
        reason: (error as Error).message,
      };
    }
  }

  /**
   * R130（2026-11-02）：**安全点删除 pending 叶子任务**（判定式）。
   */
  async removePendingTask(taskId: string): Promise<{
    readonly outcome: "removed" | "refused";
    readonly reasonCode: string;
    readonly reason: string;
  }> {
    if (this.claimedTaskIds.has(taskId)) {
      return {
        outcome: "refused",
        reasonCode: "task-running",
        reason: `任务 ${taskId} 已被领取/运行：拒绝删除。`,
      };
    }
    try {
      this.graph.removePendingLeafNode(taskId);
      await this.persistChain();
      return {
        outcome: "removed",
        reasonCode: "removed",
        reason: `任务 ${taskId} 已从任务链删除（仅 pending 叶子节点）。`,
      };
    } catch (error) {
      return {
        outcome: "refused",
        reasonCode: "invalid-task-chain",
        reason: (error as Error).message,
      };
    }
  }
  isAtSafePointForInjection(): boolean {
    return this.claimedTaskIds.size === 0;
  }

  private async persistChain(): Promise<void> {
    await this.options.taskStore.updateTaskChain(this.missionId, (current) => {
      const previousRevision = current?.revision ?? 0;
      return {
        schemaVersion: TASK_CHAIN_SCHEMA_VERSION,
        missionId: this.missionId,
        revision: previousRevision + 1,
        updatedAtIso: new Date().toISOString(),
        tasks: this.graph.getNodes(),
      };
    });
  }

  /**
   * R126：请求"下一个轮次优先启动该任务"。
   *
   * 真实约束（不静默放宽）：任务必须存在、处于 pending、且依赖全部 done；
   * 运行中/已领取的任务不能再"派发"一次。
   */
  preferTaskDispatch(
    taskId: string,
    options?: { readonly allowUnmetDependencies?: boolean },
  ): {
    readonly outcome: "accepted" | "refused";
    readonly reasonCode: string;
    readonly reason: string;
  } {
    const node = this.graph.getNode(taskId);
    if (node === undefined) {
      return {
        outcome: "refused",
        reasonCode: "task-not-found",
        reason: `任务 ${taskId} 不在任务链中。`,
      };
    }
    if (this.claimedTaskIds.has(taskId) || node.status === "running") {
      return {
        outcome: "refused",
        reasonCode: "task-already-running",
        reason: `任务 ${taskId} 已在运行，拒绝重复派发。`,
      };
    }
    if (node.status !== "pending") {
      return {
        outcome: "refused",
        reasonCode: "task-not-dispatchable",
        reason: `任务 ${taskId} 当前状态为 ${node.status}：只有 pending 任务可按需派发（blocked/failed 需先 retry/reassign）。`,
      };
    }
    const unmetDependencies = node.dependsOn.filter(
      (dependencyId) => this.graph.getNode(dependencyId)?.status !== "done",
    );
    if (unmetDependencies.length > 0) {
      if (options?.allowUnmetDependencies === true) {
        this.forcedDispatchTaskIds.add(taskId);
        return {
          outcome: "accepted",
          reasonCode: "forced-dispatch",
          reason: `任务 ${taskId} 的依赖未完成（${unmetDependencies.join(", ")}），已按显式请求乱序派发；风险由调用方承担。`,
        };
      }
      return {
        outcome: "refused",
        reasonCode: "dependencies-unmet",
        reason: `任务 ${taskId} 的依赖未完成：${unmetDependencies.join(", ")}（未请求乱序派发）。`,
      };
    }
    this.preferredDispatchTaskIds.add(taskId);
    return {
      outcome: "accepted",
      reasonCode: "preferred",
      reason: `任务 ${taskId} 将在下一次调度轮次优先启动。`,
    };
  }
}