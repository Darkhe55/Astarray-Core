/**
 * F 阶段 R38（2026-10-29）：**本地要求评估**（把真实本地状态映射成 V 的依据）。
 *
 * 背景：`GoalDispatchGate.recordGroupCompletion` 与 `computeGoalPotential` 都在，
 * 但**没有任何调用方**，也没有人把"任务链状态 + 独立裁决 + 完成收据"翻译成要求评估。
 *
 * 规则（保守，绝不把"模型说完成"当证据）：
 * - 要求已映射任务节点，且**全部节点在 mission 链上为 done**，且**每个节点都有 accepted 裁决**
 *   ⇒ `valid`（`evidenceKind: "independent-acceptance"`，引用 `task-ledger:<task>`）；
 * - 要求**尚未映射任务节点** ⇒ `unverified`（原因写清）；
 * - 部分节点未完成/无裁决 ⇒ `unverified`（列出缺口节点）；
 * - 本模块**不读模型输出**、不做模糊匹配。
 */
import type {
  GoalContract,
  GoalRequirementEvidence,
} from "./goal-contract.js";

export interface LocalGoalRequirementAssessment {
  readonly requirementIdentifier: string;
  readonly evidence: GoalRequirementEvidence;
}

export interface AssessGoalRequirementsInput {
  readonly contract: GoalContract;
  /** mission 任务链：taskId → status（只取真实状态，不做推断）。 */
  readonly missionTaskStatusByTaskIdentifier: ReadonlyMap<string, string>;
  /** 已有 accepted 独立裁决的任务（来自 `CompletionVerdictStore`）。 */
  readonly taskIdentifiersWithAcceptedVerdict: ReadonlySet<string>;
  /**
   * R72（K2）：**动态映射优先**（来自 `GoalRequirementMappingStore`）。
   *
   * 给了且该要求有映射 ⇒ 用它；否则回退契约里的静态 `taskNodeIdentifiers`。
   */
  readonly taskNodeIdentifiersByRequirement?: ReadonlyMap<string, readonly string[]>;
  /**
   * R82（2026-10-31）：**有验证收据的任务**（`hasVerifiedCompletionControlEvent` 且至少一个产物）。
   *
   * 用于 `deterministic-check` 谓词：本地可核对"任务完成 + 收据 + 产物"即记 0，
   * 不必强依赖独立验收裁决（卡允许"确定性判据或独立验收"二者其一）。
   * 未提供 ⇒ 行为不变（仍只认 accepted 裁决）。
   */
  readonly taskIdentifiersWithVerifiedReceipt?: ReadonlySet<string>;
}

export function assessGoalRequirementsFromLocalState(
  input: AssessGoalRequirementsInput,
): LocalGoalRequirementAssessment[] {
  return input.contract.requirements.map((requirement) => {
    const boundTaskIdentifiers =
      input.taskNodeIdentifiersByRequirement?.get(requirement.requirementIdentifier) ??
      requirement.taskNodeIdentifiers;
    if (boundTaskIdentifiers.length === 0) {
      return {
        requirementIdentifier: requirement.requirementIdentifier,
        evidence: {
          kind: "unverified",
          reason: "该要求尚未映射到任务节点（没有可核对的本地证据）。",
        },
      } satisfies LocalGoalRequirementAssessment;
    }
    const missingTaskIdentifiers: string[] = [];
    for (const taskIdentifier of boundTaskIdentifiers) {
      const missionStatus = input.missionTaskStatusByTaskIdentifier.get(taskIdentifier);
      if (missionStatus !== "done") {
        missingTaskIdentifiers.push(
          `${taskIdentifier}(mission=${missionStatus ?? "缺失"})`,
        );
        continue;
      }
      const hasAcceptedVerdict = input.taskIdentifiersWithAcceptedVerdict.has(
        taskIdentifier,
      );
      const hasVerifiedReceipt =
        requirement.completionPredicateKind === "deterministic-check" &&
        (input.taskIdentifiersWithVerifiedReceipt?.has(taskIdentifier) ?? false);
      if (!hasAcceptedVerdict && !hasVerifiedReceipt) {
        missingTaskIdentifiers.push(
          requirement.completionPredicateKind === "deterministic-check"
            ? `${taskIdentifier}(缺 accepted 裁决或验证收据)`
            : `${taskIdentifier}(缺 accepted 裁决)`,
        );
      }
    }
    if (missingTaskIdentifiers.length > 0) {
      return {
        requirementIdentifier: requirement.requirementIdentifier,
        evidence: {
          kind: "unverified",
          reason: `任务节点未全部满足: ${missingTaskIdentifiers.join(", ")}`,
        },
      } satisfies LocalGoalRequirementAssessment;
    }
    /**
     * R82：证据来源如实标注——**全部**任务都有 accepted 裁决才叫独立验收；
     * 否则是"确定性判据"（done + 验证收据 + 产物）。
     */
    const areAllTasksAccepted = boundTaskIdentifiers.every((taskIdentifier) =>
      input.taskIdentifiersWithAcceptedVerdict.has(taskIdentifier),
    );
    return {
      requirementIdentifier: requirement.requirementIdentifier,
      evidence: areAllTasksAccepted
        ? {
            kind: "valid",
            evidenceKind: "independent-acceptance",
            evidenceReference: `task-ledger:${boundTaskIdentifiers.join(",")}`,
          }
        : {
            kind: "valid",
            evidenceKind: "deterministic-check",
            evidenceReference: `completion-receipt:${boundTaskIdentifiers.join(",")}`,
          },
    } satisfies LocalGoalRequirementAssessment;
  });
}