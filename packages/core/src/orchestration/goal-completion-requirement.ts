/**
 * R74（2026-10-31）：**目标完成判定**（K7 的纯逻辑）。
 *
 * 卡 03 / 用户描述："直到目标完成才标记完成"。在受约束口径下，本函数只回答：
 * **当前已枚举要求是否全部有本地证据（V=0）**，不宣称现实世界完整正确。
 *
 * 规则（保守）：
 * - 状态缺失 / revision 不一致 / 需重规划 / 已暂停 ⇒ 不允许判完成（给出具体原因）；
 * - **实验已关闭 ⇒ 视为不适用**（关闭后目标不再治理任务，不能因此阻断收口）；
 * - 每条契约要求都必须有 `valid` 依据且 `remainingContribution === 0`；
 * - 缺失/多余依据都视为不通过（不静默忽略）；
 * - `lastPotentialValue` 必须为 0（且不能是 null）。
 */
import type { GoalContract } from "./goal-contract.js";
import type { PersistedGoalModeState } from "./goal-mode-store.js";

export interface GoalCompletionDecision {
  readonly isAllowed: boolean;
  readonly reasons: readonly string[];
  /** 目标未绑定/已关闭时为 true：调用方应视为"本次不适用"而不是失败。 */
  readonly isApplicable: boolean;
}

export function evaluateGoalCompletion(input: {
  readonly contract: GoalContract;
  readonly state: PersistedGoalModeState;
}): GoalCompletionDecision {
  const { contract, state } = input;
  if (state.isExperimentClosed) {
    return {
      isAllowed: true,
      isApplicable: false,
      reasons: ["实验已关闭：目标不再治理任务收口，完成判定不适用。"],
    };
  }
  const reasons: string[] = [];
  if (state.contractRevision !== contract.revision) {
    reasons.push(
      `状态 revision ${String(state.contractRevision)} 与契约 ${String(contract.revision)} 不一致：先对账。`,
    );
  }
  if (state.requiresReplanning) {
    reasons.push("目标需要重新规划：证据已失效，不允许判完成。");
  }
  if (state.pauseReason !== null) {
    reasons.push(`目标处于暂停状态：${state.pauseReason}`);
  }
  const basisByRequirement = new Map(
    state.requirementBases.map((basis) => [basis.requirementIdentifier, basis]),
  );
  for (const requirement of contract.requirements) {
    const basis = basisByRequirement.get(requirement.requirementIdentifier);
    if (basis === undefined) {
      reasons.push(`要求 ${requirement.requirementIdentifier} 没有证据依据。`);
      continue;
    }
    if (basis.evidence.kind !== "valid") {
      reasons.push(
        `要求 ${requirement.requirementIdentifier} 证据不足（${basis.evidence.kind}）。`,
      );
      continue;
    }
    if (basis.remainingContribution !== 0) {
      reasons.push(
        `要求 ${requirement.requirementIdentifier} 仍有剩余量 ${String(basis.remainingContribution)}。`,
      );
    }
  }
  const contractRequirementIdentifiers = new Set(
    contract.requirements.map((requirement) => requirement.requirementIdentifier),
  );
  for (const basis of state.requirementBases) {
    if (!contractRequirementIdentifiers.has(basis.requirementIdentifier)) {
      reasons.push(`存在不属于当前契约的证据依据: ${basis.requirementIdentifier}`);
    }
  }
  if (state.lastPotentialValue === null) {
    reasons.push("还没有计算过 V：不能判完成。");
  } else if (state.lastPotentialValue !== 0) {
    reasons.push(`V 仍为 ${String(state.lastPotentialValue)}，不是 0。`);
  }
  return { isAllowed: reasons.length === 0, isApplicable: true, reasons };
}
