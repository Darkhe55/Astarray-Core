/**
 * 任务 DAG（T05）。
 * 职责：环检测、缺失依赖检测、可运行任务计算、状态迁移、失败传播。
 * 纯内存图操作；持久化由调用方（DagScheduler + TaskStore）负责。
 */
import { DomainError } from "./errors.js";
import type { TaskChainDocument, TaskDependencyNode } from "./types.js";

export class TaskGraph {
  private readonly nodesById = new Map<string, TaskDependencyNode>();
  /**
   * ALIGN-02-03（2026-11-08）：节点声明序（0 起）。
   *
   * 用于"同层稳定排序"：同优先级下**先声明先执行**，而不是字典序 ——
   * 字典序会让 `a-xxx` 永远压过先声明的 `z-yyy`，与用户可见的任务顺序不符。
   */
  private readonly declarationOrderById = new Map<string, number>();
  private nextDeclarationOrder = 0;

  constructor(nodes: TaskDependencyNode[]) {
    for (const node of nodes) {
      if (this.nodesById.has(node.id)) {
        throw new DomainError(
          "invalid-task-chain",
          `任务 ID 重复: ${node.id}`,
        );
      }
      this.nodesById.set(node.id, { ...node, dependsOn: [...node.dependsOn] });
      this.declarationOrderById.set(node.id, this.nextDeclarationOrder);
      this.nextDeclarationOrder += 1;
    }
    this.validateDependencies();
    this.validateAcyclic();
  }

  /**
   * 清单第 ① 项下半场（2026-10-28）：**运行中追加节点**。
   *
   * 只允许在**安全点**（无在途任务）调用；拒绝重复 ID 与不存在的依赖
   * （依赖必须已存在，避免插入一个永远不可运行的节点）。
   */
  addNode(node: TaskDependencyNode): void {
    if (this.nodesById.has(node.id)) {
      throw new DomainError("invalid-task-chain", `任务 ID 重复: ${node.id}`);
    }
    for (const dependencyId of node.dependsOn) {
      if (!this.nodesById.has(dependencyId)) {
        throw new DomainError(
          "invalid-task-chain",
          `追加节点的依赖不存在: ${node.id} -> ${dependencyId}（拒绝产生不可运行节点）`,
        );
      }
    }
    this.nodesById.set(node.id, { ...node, dependsOn: [...node.dependsOn] });
    this.declarationOrderById.set(node.id, this.nextDeclarationOrder);
    this.nextDeclarationOrder += 1;
    this.validateAcyclic();
  }

  static fromTaskChain(document: TaskChainDocument): TaskGraph {
    return new TaskGraph(document.tasks);
  }

  /**
   * R130（2026-11-02）：**安全点删除 pending 叶子任务**。
   *
   * 边界（刻意保守）：
   * - 只能删 `pending` 且**没有任何节点依赖它**的任务（否则下游会被悬空）；
   * - 不让删有依赖者的中间节点：那需要重连依赖，属 ADR-0052 未支持范围。
   */
  removePendingLeafNode(taskId: string): void {
    const node = this.nodesById.get(taskId);
    if (node === undefined) {
      throw new DomainError("invalid-task-chain", `任务不存在: ${taskId}`);
    }
    if (node.status !== "pending") {
      throw new DomainError(
        "invalid-task-chain",
        `只能删除 pending 任务: ${taskId}（当前 ${node.status}）`,
      );
    }
    const dependents = [...this.nodesById.values()].filter((candidate) =>
      candidate.dependsOn.includes(taskId),
    );
    if (dependents.length > 0) {
      throw new DomainError(
        "invalid-task-chain",
        `任务 ${taskId} 仍被依赖（${dependents.map((candidate) => candidate.id).join(", ")}）：拒绝删除，避免悬空依赖。`,
      );
    }
    this.nodesById.delete(taskId);
  }
  /**
   * R131（2026-11-02）：**重连依赖**（只改某一个 pending/blocked 节点的 dependsOn）。
   *
   * 边界：
   * - 只允许 `pending` 或 `blocked` 节点（运行中/终态拒绝）；
   * - 新依赖必须已存在、不含自身、且重连后**仍无环**（失败回滚）；
   * - 若节点原为 `blocked` 且新依赖全部 `done` ⇒ 自动放回 `pending`（可运行）。
   */
  rewireNodeDependencies(taskId: string, dependsOn: readonly string[]): void {
    const node = this.nodesById.get(taskId);
    if (node === undefined) {
      throw new DomainError("invalid-task-chain", `任务不存在: ${taskId}`);
    }
    if (node.status !== "pending" && node.status !== "blocked") {
      throw new DomainError(
        "invalid-task-chain",
        `只能重连 pending/blocked 任务: ${taskId}（当前 ${node.status}）`,
      );
    }
    if (dependsOn.includes(taskId)) {
      throw new DomainError(
        "invalid-task-chain",
        `任务 ${taskId} 不能依赖自身。`,
      );
    }
    for (const dependencyId of dependsOn) {
      if (!this.nodesById.has(dependencyId)) {
        throw new DomainError(
          "invalid-task-chain",
          `新依赖不存在: ${taskId} -> ${dependencyId}`,
        );
      }
    }
    const previousDependencies = [...node.dependsOn];
    node.dependsOn = [...dependsOn];
    try {
      this.validateAcyclic();
    } catch (error) {
      node.dependsOn = previousDependencies;
      throw error;
    }
    if (node.status === "blocked") {
      const isReady = node.dependsOn.every(
        (dependencyId) => this.nodesById.get(dependencyId)?.status === "done",
      );
      if (isReady) {
        this.markPendingForRetry(taskId);
      }
    }
  }
  getNode(taskId: string): TaskDependencyNode | undefined {
    return this.nodesById.get(taskId);
  }

  getTaskIds(): string[] {
    return [...this.nodesById.keys()];
  }

  getNodes(): TaskDependencyNode[] {
    return [...this.nodesById.values()].map((node) => ({
      ...node,
      dependsOn: [...node.dependsOn],
    }));
  }

  /**
   * 可运行任务：pending 且全部依赖已 done，且自身未被领取。
   *
   * 排序见 `findRunnableTaskIds` 内注释：有效优先级 → 声明序 → 任务标识。
   */
  findRunnableTaskIds(): string[] {
    const runnableTaskIds = this.getTaskIds().filter((taskId) => {
      const node = this.nodesById.get(taskId);
      if (node === undefined || node.status !== "pending") {
        return false;
      }
      return node.dependsOn.every(
        (dependencyId) =>
          this.nodesById.get(dependencyId)?.status === "done",
      );
    });
    /**
     * ALIGN-02-03（2026-11-08）：**有效优先级 + 同层稳定排序**。
     *
     * 旧实现是纯字典序 `sort()`：tier 完全不参与 ⇒ 用户层任务可能排在 Agent
     * 派生任务之后。现在：
     *   1. 有效优先级 = min(自身 tier, 所有可达后继的 tier)（紧急后继先满足）；
     *   2. 同层按**声明序**（先声明先执行）；
     *   3. 最后用 taskId 决平 —— 保证同一输入永远同一顺序。
     *
     * 准入条件不变：只有依赖全部 done 的 pending 才可运行；置顶/提权/声明序
     * 都在此集合**内部**排序，绝不让未就绪任务进入结果。
     */
    const effectivePriorityTierById = this.computeEffectivePriorityTiers();
    return runnableTaskIds.sort((left, right) => {
      const leftTier = effectivePriorityTierById.get(left) ?? 0;
      const rightTier = effectivePriorityTierById.get(right) ?? 0;
      if (leftTier !== rightTier) return leftTier - rightTier;
      const leftOrder = this.declarationOrderById.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = this.declarationOrderById.get(right) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.localeCompare(right);
    });
  }

  /**
   * ALIGN-02-03：有效优先级 = `min(自身 tier, 所有可达后继的 tier)`。
   *
   * 语义：一个"闸门"任务即使自身是低优先级，只要它挡着紧急后继，就应先跑。
   * 记忆化 DFS；环由构造期校验排除，这里额外用占位值防自旋（防御性）。
   */
  computeEffectivePriorityTiers(): Map<string, number> {
    const successorIdentifiersById = new Map<string, string[]>();
    for (const node of this.nodesById.values()) {
      for (const dependencyIdentifier of node.dependsOn) {
        const successors = successorIdentifiersById.get(dependencyIdentifier) ?? [];
        successors.push(node.id);
        successorIdentifiersById.set(dependencyIdentifier, successors);
      }
    }
    const resolved = new Map<string, number>();
    const effectivePriorityTierOf = (taskIdentifier: string): number => {
      const cached = resolved.get(taskIdentifier);
      if (cached !== undefined) return cached;
      const node = this.nodesById.get(taskIdentifier);
      if (node === undefined) return Number.MAX_SAFE_INTEGER;
      /** 先占位，避免异常图导致无限递归（缺省 tier 按 0 = 用户层）。 */
      const declaredPriorityTier = node.priorityTier ?? 0;
      resolved.set(taskIdentifier, declaredPriorityTier);
      let effectivePriorityTier = declaredPriorityTier;
      for (const successorIdentifier of successorIdentifiersById.get(taskIdentifier) ?? []) {
        effectivePriorityTier = Math.min(
          effectivePriorityTier,
          effectivePriorityTierOf(successorIdentifier),
        );
      }
      resolved.set(taskIdentifier, effectivePriorityTier);
      return effectivePriorityTier;
    };
    for (const taskIdentifier of this.nodesById.keys()) {
      effectivePriorityTierOf(taskIdentifier);
    }
    return resolved;
  }

  isMissionComplete(): boolean {
    return this.getTaskIds().every(
      (taskId) => this.nodesById.get(taskId)?.status === "done",
    );
  }

  markRunning(taskId: string): void {
    this.transitionTo(taskId, "running", ["pending"]);
  }

  markDone(taskId: string, resultLocation: string | null): void {
    const node = this.transitionTo(taskId, "done", ["running"]);
    node.resultLocation = resultLocation;
  }

  markFailed(taskId: string): void {
    this.transitionTo(taskId, "failed", ["running", "pending"]);
  }

  markBlocked(taskId: string): void {
    this.transitionTo(taskId, "blocked", ["pending", "running"]);
  }

  /** 恢复为 pending（retry/reassign/cancel/人工放行），清空指派。 */
  markPendingForRetry(taskId: string): void {
    const node = this.transitionTo(taskId, "pending", [
      "running",
      "failed",
      "blocked",
    ]);
    node.assignedAgentId = null;
  }

  /**
   * 失败传播：将依赖该失败任务的下游任务标记为 blocked。
   * 返回被阻塞的任务 ID 列表。
   */
  propagateFailureToDownstream(failedTaskId: string): string[] {
    const blockedTaskIds: string[] = [];
    for (const taskId of this.getTaskIds()) {
      const node = this.nodesById.get(taskId);
      if (node === undefined || node.status !== "pending") {
        continue;
      }
      if (node.dependsOn.includes(failedTaskId)) {
        node.status = "blocked";
        blockedTaskIds.push(taskId);
      }
    }
    return blockedTaskIds;
  }

  assignAgent(taskId: string, agentId: string): void {
    const node = this.nodesById.get(taskId);
    if (node === undefined) {
      throw new DomainError("dependency-not-found", `任务不存在: ${taskId}`);
    }
    node.assignedAgentId = agentId;
  }

  private transitionTo(
    taskId: string,
    nextStatus: TaskDependencyNode["status"],
    allowedPreviousStatuses: TaskDependencyNode["status"][],
  ): TaskDependencyNode {
    const node = this.nodesById.get(taskId);
    if (node === undefined) {
      throw new DomainError("dependency-not-found", `任务不存在: ${taskId}`);
    }
    if (!allowedPreviousStatuses.includes(node.status)) {
      throw new DomainError(
        "invalid-task-chain",
        `非法状态迁移: ${taskId} ${node.status} → ${nextStatus}`,
      );
    }
    node.status = nextStatus;
    return node;
  }

  private validateDependencies(): void {
    for (const node of this.nodesById.values()) {
      for (const dependencyId of node.dependsOn) {
        if (!this.nodesById.has(dependencyId)) {
          throw new DomainError(
            "dependency-not-found",
            `任务 ${node.id} 依赖不存在的任务 ${dependencyId}`,
          );
        }
      }
    }
  }

  private validateAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (taskId: string): void => {
      if (visited.has(taskId)) {
        return;
      }
      if (visiting.has(taskId)) {
        throw new DomainError(
          "dag-cycle",
          `任务依赖存在环: ${taskId}`,
        );
      }
      visiting.add(taskId);
      const node = this.nodesById.get(taskId);
      for (const dependencyId of node?.dependsOn ?? []) {
        visit(dependencyId);
      }
      visiting.delete(taskId);
      visited.add(taskId);
    };

    for (const taskId of this.getTaskIds()) {
      visit(taskId);
    }
  }
}
