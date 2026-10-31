/**
 * R79（2026-10-31）：**证据失效的状态变更**（K5 的纯逻辑）。
 *
 * 背景：卡 02 要求"证据失效导致 V 上升时保留事实、暂停并重新规划，禁止修改权重掩盖倒退"；
 * 门禁已有 `recordEvidenceInvalidation`，但**没有生产者**（谁判定失效、怎么落到状态）。
 *
 * 本模块只做**纯状态变换**：把指定要求的证据标记为 `invalidated`、按权重重算 V、
 * 置 `requiresReplanning` 与暂停原因、记录证据缺口。是否真的暂停由门禁按此状态执行。
 *
 * 注意：不删除旧事实（旧的 `valid` 依据被替换为 `invalidated` + 原因，属于"保留事实"）。
 */
import { computeGoalPotential } from "./goal-contract.js";
import type { GoalContract } from "./goal-contract.js";
import type {
  PersistedGoalModeState,
  PersistedGoalRequirementBasis,
} from "./goal-mode-store.js";

export interface GoalEvidenceInvalidationResult {
  readonly nextState: PersistedGoalModeState;
  /** 失效后的 V；`null` 表示无法给出可靠数值（存在 unreliable 谓词），不是 0。 */
  readonly potentialValueAfterInvalidation: number | null;
  readonly invalidatedRequirementIdentifiers: readonly string[];
}

export function buildInvalidatedGoalState(input: {
  readonly contract: GoalContract;
  readonly state: PersistedGoalModeState;
  readonly requirementIdentifiers: readonly string[];
  readonly reason: string;
  readonly nowIso: string;
}): GoalEvidenceInvalidationResult {
  const invalidatedIdentifiers = new Set(input.requirementIdentifiers);
  const contractRequirementIdentifiers = new Set(
    input.contract.requirements.map((requirement) => requirement.requirementIdentifier),
  );
  for (const requirementIdentifier of invalidatedIdentifiers) {
    if (!contractRequirementIdentifiers.has(requirementIdentifier)) {
      throw new Error(`要求 ${requirementIdentifier} 不在当前契约中，不能标记为证据失效。`);
    }
  }
  const nextBases: PersistedGoalRequirementBasis[] = input.state.requirementBases.map((basis) =>
    invalidatedIdentifiers.has(basis.requirementIdentifier)
      ? {
          requirementIdentifier: basis.requirementIdentifier,
          weight: basis.weight,
          /** 保留"曾经 valid"的事实吗？不：这里只保留失效后的事实与原因。 */
          evidence: {
            kind: "invalidated",
            reason: input.reason,
          },
          remainingContribution: basis.weight,
        }
      : basis,
  );
  const potentialResult = computeGoalPotential({
    contract: input.contract,
    assessments: nextBases.map((basis) => ({
      requirementIdentifier: basis.requirementIdentifier,
      evidence: basis.evidence,
    })),
  });
  const potentialValueAfterInvalidation =
    potentialResult.status === "computed" ? potentialResult.potentialValue : null;
  const invalidationGaps = [...invalidatedIdentifiers].map(
    (requirementIdentifier) =>
      `要求 ${requirementIdentifier} 的证据已失效（${input.reason}）`,
  );
  const pauseReason = `证据失效导致需要重新规划：${input.reason}`;
  return {
    nextState: {
      ...input.state,
      documentRevision: input.state.documentRevision + 1,
      requirementBases: nextBases,
      lastPotentialValue: potentialValueAfterInvalidation,
      pauseReason,
      evidenceGaps: [...input.state.evidenceGaps, ...invalidationGaps],
      requiresReplanning: true,
      gateSnapshot: {
        ...input.state.gateSnapshot,
        isPaused: true,
        pauseReason,
        requiresReplanning: true,
        lastPotentialValue: potentialValueAfterInvalidation,
        evidenceGaps: [...input.state.gateSnapshot.evidenceGaps, ...invalidationGaps],
      },
      updatedAtIso: input.nowIso,
    },
    potentialValueAfterInvalidation,
    invalidatedRequirementIdentifiers: [...invalidatedIdentifiers],
  };
}
