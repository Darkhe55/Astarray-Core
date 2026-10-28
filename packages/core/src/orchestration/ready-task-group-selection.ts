/**
 * ALIGN-02-03（2026-10-28）：从 **ready set** 选出一次模型任务组的工作单元。
 *
 * 卡内要求：按**有效优先级**选择；依赖先满足；用户层最高；同层稳定排序；
 * **不得把未满足依赖的任务靠置顶强行执行**；个体任务链**打包**复用原包契约，
 * 一次任务组可引用一个或多个已就绪包，**不删除包内边界**。
 *
 * 本模块是纯函数（不读盘、不改状态），只回答"这一轮该派哪些单元"：
 *
 * 1. **候选只来自 ready set**：`pending` 且全部直接前驱 `done`。任何未满足依赖的
 *    任务**永远不会**出现在结果里 —— 置顶、提权、包内顺序都不能绕过这条。
 * 2. **有效优先级**：`effectivePriorityTier(task) = min(自身 tier, 可达后继的 tier)`。
 *    即"高优先任务所必需的前驱"会随其后继一起升高优先级（与
 *    `TaskSequencePartialOrder.explainOrder` 的"必要前驱可先行"口径一致），
 *    但只对**已就绪**的前驱生效，不构成对阻塞任务的放行。
 * 3. **任务包是不可拆的单位**：`prepared` 包整体参与选择；包内任一任务非 `pending`
 *    或首任务未就绪 ⇒ 整个包推迟（**不拆包、不跳过包内节点**）。
 * 4. **同层稳定排序**：`(有效优先级, 最小 sequenceOrdinal, 单元标识)` 三级比较，
 *    结果可重放。
 * 5. **预算按单元计**：`maximumUnitCount` 限制本次任务组引用的单元数（包算 1 个单元，
 *    包内任务数不变）；装不下的单元整体推迟，**不截断包**。
 */
import { DomainError } from "../core/errors.js";
import type { AgentTaskNode, TaskBundleRecord } from "../core/types.js";

export interface ReadyTaskUnit {
  readonly unitKind: "task" | "bundle";
  /** 任务单元 = 任务标识；包单元 = 包标识（稳定、可追溯）。 */
  readonly unitIdentifier: string;
  /** 单元覆盖的任务（包单元按包内既定顺序，不重排）。 */
  readonly taskIdentifiers: readonly string[];
  /** 单元内最小的有效优先级（用于排序）。 */
  readonly effectivePriorityTier: number;
  /** 单元内最小的创建序号（同层稳定排序）。 */
  readonly minimumSequenceOrdinal: number;
  readonly bundleIdentifier: string | null;
  readonly boundAgentInstanceIdentifier: string | null;
}

export interface ReadyTaskGroupSelection {
  /** 本次可派发的单元（已排序、已按预算截断）。 */
  readonly units: readonly ReadyTaskUnit[];
  /** 就绪但本次未装下（或整包推迟）的单元。 */
  readonly deferredUnits: readonly ReadyTaskUnit[];
  /** ready set 的任务（不论是否被打包/选中）。 */
  readonly readyTaskIdentifiers: readonly string[];
  /** 每个任务的有效优先级（用于解释"为什么先做它"）。 */
  readonly effectivePriorityTierByTaskIdentifier: Readonly<Record<string, number>>;
  /** 单元 → 推迟原因（未推迟的单元不出现）。 */
  readonly deferredReasons: Readonly<Record<string, string>>;
}

export interface ReadyTaskGroupSelectionInput {
  readonly nodes: readonly AgentTaskNode[];
  readonly bundles: readonly TaskBundleRecord[];
  /** 一次任务组最多引用的单元数（包算一个单元）。 */
  readonly maximumUnitCount: number;
}

export function selectReadyTaskUnits(
  input: ReadyTaskGroupSelectionInput,
): ReadyTaskGroupSelection {
  if (!Number.isInteger(input.maximumUnitCount) || input.maximumUnitCount < 1) {
    throw new DomainError(
      "invalid-task-chain",
      `任务组单元预算必须是 ≥1 的整数（当前 ${input.maximumUnitCount}）。`,
    );
  }
  const nodesByTaskIdentifier = new Map<string, AgentTaskNode>();
  for (const node of input.nodes) {
    nodesByTaskIdentifier.set(node.taskId, node);
  }

  const readyTaskIdentifiers = input.nodes
    .filter((node) => isTaskReady(node, nodesByTaskIdentifier))
    .map((node) => node.taskId);
  const readyTaskIdentifierSet = new Set(readyTaskIdentifiers);
  const effectivePriorityTierByTaskIdentifier = computeEffectivePriorityTiers(
    input.nodes,
    nodesByTaskIdentifier,
  );

  const deferredReasons: Record<string, string> = {};
  const units: ReadyTaskUnit[] = [];
  const bundledTaskIdentifiers = new Set<string>();

  for (const bundle of input.bundles) {
    if (bundle.status !== "prepared") {
      continue;
    }
    for (const taskIdentifier of bundle.taskIds) {
      bundledTaskIdentifiers.add(taskIdentifier);
    }
    const unitIdentifier = bundle.bundleId;
    const firstTaskIdentifier = bundle.taskIds[0];
    if (firstTaskIdentifier === undefined) {
      deferredReasons[unitIdentifier] = "任务包为空";
      continue;
    }
    const nonPendingTaskIdentifiers = bundle.taskIds.filter(
      (taskIdentifier) => nodesByTaskIdentifier.get(taskIdentifier)?.status !== "pending",
    );
    if (nonPendingTaskIdentifiers.length > 0) {
      deferredReasons[unitIdentifier] =
        `任务包内存在非 pending 任务: ${nonPendingTaskIdentifiers.join(", ")}`;
      continue;
    }
    if (!readyTaskIdentifierSet.has(firstTaskIdentifier)) {
      const firstNode = nodesByTaskIdentifier.get(firstTaskIdentifier);
      const unfinishedDependencyIdentifiers =
        firstNode?.dependsOn.filter(
          (dependencyIdentifier) =>
            nodesByTaskIdentifier.get(dependencyIdentifier)?.status !== "done",
        ) ?? [];
      deferredReasons[unitIdentifier] =
        unfinishedDependencyIdentifiers.length > 0
          ? `首任务前驱未完成: ${unfinishedDependencyIdentifiers.join(", ")}`
          : `首任务状态不是 pending: ${firstNode?.status ?? "缺失"}`;
      continue;
    }
    units.push(
      buildUnit({
        unitKind: "bundle",
        unitIdentifier,
        taskIdentifiers: bundle.taskIds,
        bundleIdentifier: bundle.bundleId,
        boundAgentInstanceIdentifier: bundle.boundAgentInstanceId,
        effectivePriorityTierByTaskIdentifier,
        nodesByTaskIdentifier,
      }),
    );
  }

  for (const taskIdentifier of readyTaskIdentifiers) {
    if (bundledTaskIdentifiers.has(taskIdentifier)) {
      continue;
    }
    units.push(
      buildUnit({
        unitKind: "task",
        unitIdentifier: taskIdentifier,
        taskIdentifiers: [taskIdentifier],
        bundleIdentifier: null,
        boundAgentInstanceIdentifier: null,
        effectivePriorityTierByTaskIdentifier,
        nodesByTaskIdentifier,
      }),
    );
  }

  units.sort(compareUnits);
  const selectedUnits = units.slice(0, input.maximumUnitCount);
  const deferredUnits = units.slice(input.maximumUnitCount);
  for (const unit of deferredUnits) {
    deferredReasons[unit.unitIdentifier] = "超出本次任务组单元预算（整单元推迟，不拆包）";
  }

  return {
    units: selectedUnits,
    deferredUnits,
    readyTaskIdentifiers,
    effectivePriorityTierByTaskIdentifier,
    deferredReasons,
  };
}

/**
 * ready 定义：`pending` 且**所有直接前驱已 done**。
 *
 * 故意不复用 `TaskSequencePartialOrder.getReadyTaskIds` 的排序：这里需要
 * **有效优先级**（含必要前驱提升），而 ready 集合本身的定义必须逐字一致。
 */
function isTaskReady(
  node: AgentTaskNode,
  nodesByTaskIdentifier: ReadonlyMap<string, AgentTaskNode>,
): boolean {
  if (node.status !== "pending") {
    return false;
  }
  return node.dependsOn.every(
    (dependencyIdentifier) =>
      nodesByTaskIdentifier.get(dependencyIdentifier)?.status === "done",
  );
}

/**
 * 有效优先级：`min(自身 tier, 所有可达后继的 tier)`。
 *
 * 用记忆化 DFS；环由序列层保证不存在（这里防御性截断 visited，不递归自旋）。
 */
function computeEffectivePriorityTiers(
  nodes: readonly AgentTaskNode[],
  nodesByTaskIdentifier: ReadonlyMap<string, AgentTaskNode>,
): Record<string, number> {
  const successorIdentifiersByTaskIdentifier = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependencyIdentifier of node.dependsOn) {
      const successors =
        successorIdentifiersByTaskIdentifier.get(dependencyIdentifier) ?? [];
      successors.push(node.taskId);
      successorIdentifiersByTaskIdentifier.set(dependencyIdentifier, successors);
    }
  }
  const resolved = new Map<string, number>();
  const effectivePriorityTierOf = (taskIdentifier: string): number => {
    const cached = resolved.get(taskIdentifier);
    if (cached !== undefined) {
      return cached;
    }
    const node = nodesByTaskIdentifier.get(taskIdentifier);
    if (node === undefined) {
      return Number.MAX_SAFE_INTEGER;
    }
    /** 先占位防止异常图（理论上有环）导致无限递归。 */
    resolved.set(taskIdentifier, node.priorityTier);
    let effectivePriorityTier = node.priorityTier;
    for (const successorIdentifier of
      successorIdentifiersByTaskIdentifier.get(taskIdentifier) ?? []) {
      effectivePriorityTier = Math.min(
        effectivePriorityTier,
        effectivePriorityTierOf(successorIdentifier),
      );
    }
    resolved.set(taskIdentifier, effectivePriorityTier);
    return effectivePriorityTier;
  };
  const result: Record<string, number> = {};
  for (const node of nodes) {
    result[node.taskId] = effectivePriorityTierOf(node.taskId);
  }
  return result;
}

function buildUnit(input: {
  readonly unitKind: "task" | "bundle";
  readonly unitIdentifier: string;
  readonly taskIdentifiers: readonly string[];
  readonly bundleIdentifier: string | null;
  readonly boundAgentInstanceIdentifier: string | null;
  readonly effectivePriorityTierByTaskIdentifier: Readonly<Record<string, number>>;
  readonly nodesByTaskIdentifier: ReadonlyMap<string, AgentTaskNode>;
}): ReadyTaskUnit {
  const priorities = input.taskIdentifiers.map(
    (taskIdentifier) =>
      input.effectivePriorityTierByTaskIdentifier[taskIdentifier] ?? Number.MAX_SAFE_INTEGER,
  );
  const ordinals = input.taskIdentifiers.map(
    (taskIdentifier) =>
      input.nodesByTaskIdentifier.get(taskIdentifier)?.sequenceOrdinal ??
      Number.MAX_SAFE_INTEGER,
  );
  return {
    unitKind: input.unitKind,
    unitIdentifier: input.unitIdentifier,
    taskIdentifiers: [...input.taskIdentifiers],
    effectivePriorityTier: Math.min(...priorities),
    minimumSequenceOrdinal: Math.min(...ordinals),
    bundleIdentifier: input.bundleIdentifier,
    boundAgentInstanceIdentifier: input.boundAgentInstanceIdentifier,
  };
}

function compareUnits(left: ReadyTaskUnit, right: ReadyTaskUnit): number {
  if (left.effectivePriorityTier !== right.effectivePriorityTier) {
    return left.effectivePriorityTier - right.effectivePriorityTier;
  }
  if (left.minimumSequenceOrdinal !== right.minimumSequenceOrdinal) {
    return left.minimumSequenceOrdinal - right.minimumSequenceOrdinal;
  }
  return left.unitIdentifier.localeCompare(right.unitIdentifier);
}
