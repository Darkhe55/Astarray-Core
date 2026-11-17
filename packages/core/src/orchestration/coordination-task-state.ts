/**
 * COORD-01-02（2026-11-16，检查点 2 第二步）：**把消费结果落到权威任务链**。
 *
 * 目的：消费步只更新协调器内部状态；本模块负责把它映射到**权威任务链**
 * （`TaskStorePort.updateTaskChain`，带 revision 保护），这是"任务状态更新"的唯一真相。
 *
 * 纪律：
 * - 只按**本地可信字段**判断状态（`payload.kind`），不读模型自述；
 * - 不认识的消息类型 ⇒ `status-unchanged`，**不猜**、不写盘；
 * - 找不到任务 ⇒ `task-not-found`，不新建任务、不改别的任务；
 * - 写入走 revision 递增，避免覆盖并发写者（`stale-revision` 由 store 抛错）。
 */
import { DomainError } from "../core/errors.js";
import type { TaskChainDocument, TaskStorePort } from "../core/types.js";

/**
 * 只有 done / failed 两种。
 *
 * **没有 blocked**：反馈载荷 schema（`core/types.ts` 的 `FeedbackMessagePayload`）
 * 根本不存在 `kind: "blocked"`；任务被置为 blocked 一律由调度器
 * `blockTaskForHumanDecision` 依据本地事实判定，Agent 不能自报阻塞。
 */
export type CoordinationTaskStatus = "done" | "failed";

export interface CoordinationTaskStateApplicationResult {
  readonly outcome: "applied" | "task-not-found" | "status-unchanged";
  readonly missionIdentifier: string | null;
  readonly taskStatus: CoordinationTaskStatus | null;
}

/**
 * 从载荷判定任务状态迁移。
 *
 * 只认这两种：成功 / 失败。其它（澄清请求、协作请求、普通进度）不改变任务状态。\n *\n * 阻塞**不在这里**：它是调度器基于本地事实的判定，不存在对应的反馈载荷类型。
 */
export function resolveCoordinationTaskStatus(payload: unknown): CoordinationTaskStatus | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const kind = (payload as Record<string, unknown>)["kind"];
  if (kind === "success") return "done";
  if (kind === "failure") return "failed";
  return null;
}

/**
 * 把一条协调消息应用到任务链。
 *
 * `missionIdentifiers` 由调用方给出（来自任务目录索引），本模块只在其中查找目标任务，
 * 不自行扫描文件系统、也不维护第二套任务索引。
 */
export async function applyCoordinationMessageToTaskState(input: {
  readonly taskStore: Pick<TaskStorePort, "readTaskChain" | "updateTaskChain">;
  readonly missionIdentifiers: readonly string[];
  readonly message: {
    readonly messageIdentifier: string;
    readonly taskIdentifier: string | null;
    readonly payload: unknown;
  };
  /**
   * WIRING-04-03：**受控完成凭证**（非活动 mission 的持久状态入口）。
   *
   * 与 `completeTaskByTaskIdentifier` 同一纪律：标记 `done` 必须携带
   * 权威完成校验已通过的凭证，防止新增调用方绕过门禁。
   */
  readonly completionAuthorization?: {
    readonly code: "authoritative-completion-accepted";
    readonly decidedAtIso: string;
  };
}): Promise<CoordinationTaskStateApplicationResult> {
  const taskStatus = resolveCoordinationTaskStatus(input.message.payload);
  if (taskStatus === null || input.message.taskIdentifier === null) {
    return { outcome: "status-unchanged", missionIdentifier: null, taskStatus: null };
  }
  if (taskStatus === "done" && input.completionAuthorization === undefined) {
    throw new DomainError(
      "completion-not-authorized",
      `任务 ${input.message.taskIdentifier} 的 done 缺少权威校验凭证（不得直接写任务链）`,
    );
  }
  const taskIdentifier = input.message.taskIdentifier;
  for (const missionIdentifier of input.missionIdentifiers) {
    const chain = await input.taskStore.readTaskChain(missionIdentifier);
    if (chain === null) {
      continue;
    }
    const target = chain.tasks.find((task) => task.id === taskIdentifier);
    if (target === undefined) {
      continue;
    }
    /** 已经是目标状态 ⇒ 不产生无意义的 revision 递增（幂等重放不该反复写盘）。 */
    if (target.status === taskStatus) {
      return { outcome: "status-unchanged", missionIdentifier, taskStatus };
    }
    /**
     * WIRING-04-01：**同一条消息的应用证据与任务状态变更写在同一个文档、同一次提交**。
     *
     * 判重放在 updater 内部（而不是先读后写），因此并发重放不会各写一次。
     */
    let didApply = false;
    await input.taskStore.updateTaskChain(missionIdentifier, (current) => {
      const base: TaskChainDocument =
        current ?? {
          schemaVersion: chain.schemaVersion,
          missionId: missionIdentifier,
          revision: chain.revision,
          updatedAtIso: chain.updatedAtIso,
          tasks: chain.tasks,
          ...(chain.coordinationApplicationEvidence === undefined
            ? {}
            : { coordinationApplicationEvidence: chain.coordinationApplicationEvidence }),
        };
      const existingEvidence = base.coordinationApplicationEvidence ?? [];
      if (
        existingEvidence.some(
          (evidence) => evidence.messageIdentifier === input.message.messageIdentifier,
        )
      ) {
        /** 同消息已应用 ⇒ 原样返回（不递增 revision，不产生第二次状态迁移）。 */
        return base;
      }
      const targetTask = base.tasks.find((task) => task.id === taskIdentifier);
      if (targetTask === undefined || targetTask.status === taskStatus) {
        return base;
      }
      didApply = true;
      return {
        ...base,
        revision: base.revision + 1,
        updatedAtIso: new Date().toISOString(),
        tasks: base.tasks.map((task) =>
          task.id === taskIdentifier ? { ...task, status: taskStatus } : task,
        ),
        coordinationApplicationEvidence: [
          ...existingEvidence,
          {
            messageIdentifier: input.message.messageIdentifier,
            appliedAtIso: new Date().toISOString(),
            resultingTaskStatus: taskStatus,
          },
        ],
      };
    });
    if (!didApply) {
      return { outcome: "status-unchanged", missionIdentifier, taskStatus };
    }
    return { outcome: "applied", missionIdentifier, taskStatus };
  }
  return { outcome: "task-not-found", missionIdentifier: null, taskStatus };
}
