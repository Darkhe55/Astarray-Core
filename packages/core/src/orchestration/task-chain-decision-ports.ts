/**
 * COORD-05 05-05 接线（2026-11-22）：**任务链端口适配器**。
 *
 * 把真实 `TaskStore` 接到 `DecisionWritebackPorts`：
 * - 文档 revision = 任务链 revision；
 * - 写回 = 在任务链文档内**追加**一条决定证据（同一次原子提交，按 decisionIdentifier 幂等）；
 * - 任务状态 = 任务链节点状态；**显式依赖决定**且尚未完成的节点映射为 waiting-on-decision；
 * - 推进仍交给调度器（`advanceStep` 回调），本适配器不直接改任务状态。
 *
 * mission 是否取消由装配层通过 `resolveMissionStatus` 提供（任务链本身不记录取消）。
 */
import type { TaskChainDocument } from "../core/types.js";
import type { TaskStore } from "../infra/task-store.js";
import type { DecisionWritebackPorts } from "./decision-writeback.js";

export interface TaskChainDecisionPortsInput {
  readonly store: TaskStore;
  readonly missionIdentifier: string;
  readonly advanceStep: (stepIdentifier: string) => Promise<void>;
  readonly resolveMissionStatus?: (
    missionIdentifier: string,
  ) => Promise<"running" | "cancelled" | "completed" | "unknown">;
  readonly nowIso?: () => string;
}

export function createTaskChainDecisionPorts(
  input: TaskChainDecisionPortsInput,
): DecisionWritebackPorts {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());

  const readChain = async (): Promise<TaskChainDocument> => {
    const chain = await input.store.readTaskChain(input.missionIdentifier);
    if (chain === null) {
      throw new Error(`任务链不存在：${input.missionIdentifier}`);
    }
    return chain;
  };

  return {
    readDocumentRevision: async () => (await readChain()).revision,

    writeDecision: async (decision) => {
      const current = await readChain();
      if (decision.expectedRevision !== null && current.revision !== decision.expectedRevision) {
        throw new Error(
          `任务链 revision 已变化：期望 ${String(decision.expectedRevision)}，当前 ${String(current.revision)}`,
        );
      }
      /** 幂等：同一决定只追加一次（已有证据 ⇒ 直接返回当前 revision）。 */
      const existing = current.decisionApplicationEvidence?.find(
        (entry) => entry.decisionIdentifier === decision.decisionIdentifier,
      );
      if (existing !== undefined) {
        return { documentRevision: current.revision };
      }
      let writtenRevision = current.revision;
      await input.store.updateTaskChain(input.missionIdentifier, (chain) => {
        if (chain === null) {
          throw new Error(`任务链不存在：${input.missionIdentifier}`);
        }
        const alreadyApplied = chain.decisionApplicationEvidence?.some(
          (entry) => entry.decisionIdentifier === decision.decisionIdentifier,
        );
        if (alreadyApplied === true) {
          writtenRevision = chain.revision;
          return chain;
        }
        const nextRevision = chain.revision + 1;
        writtenRevision = nextRevision;
        return {
          ...chain,
          revision: nextRevision,
          updatedAtIso: nowIso(),
          decisionApplicationEvidence: [
            ...(chain.decisionApplicationEvidence ?? []),
            {
              decisionIdentifier: decision.decisionIdentifier,
              escalationRequestIdentifier: decision.escalationRequestIdentifier,
              source: decision.source,
              summary: decision.summary,
              affectedStepIdentifiers: [...decision.affectedStepIdentifiers],
              appliedAtIso: nowIso(),
            },
          ],
        };
      });
      return { documentRevision: writtenRevision };
    },

    readMissionState: async () => {
      const chain = await input.store.readTaskChain(input.missionIdentifier);
      if (chain === null) {
        return { status: "unknown", steps: [] };
      }
      const status =
        input.resolveMissionStatus === undefined
          ? (() => {
              const hasOpenWork = chain.tasks.some(
                (task) =>
                  task.status === "pending" ||
                  task.status === "running" ||
                  task.status === "blocked",
              );
              return hasOpenWork ? ("running" as const) : ("completed" as const);
            })()
          : await input.resolveMissionStatus(input.missionIdentifier);
      return {
        status,
        steps: chain.tasks.map((task) => {
          const dependsOnDecision =
            (task.dependsOnDecisionIdentifiers?.length ?? 0) > 0;
          const isWaiting =
            (task.status === "pending" || task.status === "blocked") && dependsOnDecision;
          return {
            stepIdentifier: task.id,
            status: isWaiting
              ? ("waiting-on-decision" as const)
              : task.status === "blocked"
                ? ("pending" as const)
                : task.status,
            dependsOnDecisionIdentifiers: [...(task.dependsOnDecisionIdentifiers ?? [])],
          };
        }),
      };
    },

    advanceStep: (stepIdentifier) => input.advanceStep(stepIdentifier),
  };
}
