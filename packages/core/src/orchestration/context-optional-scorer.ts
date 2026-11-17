/**
 * P6：optional 候选的可插拔评分器。
 *
 * 这里的评分器只影响**未进入提示词**的候选的延后顺序/后续回访优先级，
 * 不能把 required 约束、当前任务、验收标准或安全边界降级。
 * 缺省不提供评分器 ⇒ 保持原有稳定顺序。
 */
import type { GlobalDecisionRecord } from "./context-closure-schemas.js";
import type { GlobalDecisionRelevanceCategory } from "./global-decision-selector.js";
import type { ContextPhase } from "./context-phase-policy.js";

export interface OptionalContextCandidate {
  readonly record: GlobalDecisionRecord;
  readonly category: GlobalDecisionRelevanceCategory;
  readonly estimatedTokenCount: number;
  readonly phase: ContextPhase;
}

export type OptionalContextScorer = (
  candidate: OptionalContextCandidate,
) => number;

export function rankOptionalContextCandidates(
  candidates: readonly OptionalContextCandidate[],
  scorer: OptionalContextScorer | undefined,
): readonly OptionalContextCandidate[] {
  if (scorer === undefined) return [...candidates];
  return [...candidates].sort((left, right) => {
    const scoreDifference = scorer(right) - scorer(left);
    if (scoreDifference !== 0) return scoreDifference;
    return left.record.globalDecisionIdentifier.localeCompare(
      right.record.globalDecisionIdentifier,
    );
  });
}
