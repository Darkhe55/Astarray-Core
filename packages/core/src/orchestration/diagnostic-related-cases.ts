import {
  buildDiagnosticBucketKey,
  computeJaccardSimilarity,
  computeTrigramSet,
  normalizeDiagnosticText,
  type DiagnosticClusterGroup,
  type DiagnosticClusterInput,
} from "./diagnostic-clusterer.js";
import type { DiagnosticClusterSnapshot } from "./diagnostic-cluster-index.js";

/**
 * CLUSTER-01 §3 第 7 条：**相似案例检索**。
 *
 * 卡内硬约束：
 * - 输入是**已授权的事件引用**，不接受任意待执行文本 ⇒ 本 API 只收 `DiagnosticClusterInput`，
 *   不提供「传一段字符串来查」的重载，避免调用方把模型输出直接喂进来；
 * - 同一分桶 + 同一算法；默认前 5 个，最多 20 个；最低相似度 0.85；
 * - 返回 `similarityScore` 并**显式标注它不是正确概率、也不是根因置信度**。
 */

export const DIAGNOSTIC_RELATED_DEFAULT_LIMIT = 5;
export const DIAGNOSTIC_RELATED_MAXIMUM_LIMIT = 20;

export interface DiagnosticRelatedCase {
  readonly groupIdentifier: string;
  readonly representativeSourceRecordIdentifier: string;
  readonly similarityScore: number;
  readonly memberCount: number;
  readonly firstRecordedAtIso: string;
  readonly lastRecordedAtIso: string;
}

export interface DiagnosticRelatedCasesResult {
  readonly cases: readonly DiagnosticRelatedCase[];
  readonly bucketKey: string;
  /** 恒为 false：相似度**不是**正确概率，也**不是**根因置信度（卡内要求显式声明）。 */
  readonly isRootCauseConfidence: false;
  readonly similarityThreshold: number;
  readonly limit: number;
}

export function findRelatedDiagnosticCases(input: {
  /** 已授权的事件引用（不是任意文本）。 */
  readonly event: DiagnosticClusterInput;
  readonly snapshot: DiagnosticClusterSnapshot;
  readonly limit?: number;
  readonly minimumSimilarity?: number;
}): DiagnosticRelatedCasesResult {
  const limit = Math.min(
    DIAGNOSTIC_RELATED_MAXIMUM_LIMIT,
    Math.max(1, input.limit ?? DIAGNOSTIC_RELATED_DEFAULT_LIMIT),
  );
  const minimumSimilarity = input.minimumSimilarity ?? 0.85;
  const bucketKey = buildDiagnosticBucketKey(input.event);
  const queryText = normalizeDiagnosticText(input.event.messageText);
  const queryTrigrams = computeTrigramSet(queryText);

  const scored: DiagnosticRelatedCase[] = [];
  for (const group of input.snapshot.groups) {
    /** 严格分桶：不同桶不参与相似度计算（§3 第 3 条）。 */
    if (group.bucketKey !== bucketKey) continue;
    const representative = group.members[0];
    if (representative === undefined) continue;
    const score =
      representative.normalizedText === queryText
        ? 1
        : computeJaccardSimilarity(queryTrigrams, computeTrigramSet(representative.normalizedText));
    if (score < minimumSimilarity) continue;
    scored.push({
      groupIdentifier: group.groupIdentifier,
      representativeSourceRecordIdentifier: group.representativeSourceRecordIdentifier,
      similarityScore: score,
      memberCount: group.memberCount,
      firstRecordedAtIso: group.firstRecordedAtIso,
      lastRecordedAtIso: group.lastRecordedAtIso,
    });
  }

  /** 分数降序；同分按组 ID 字典序（确定性）。 */
  scored.sort((left, right) => {
    if (left.similarityScore !== right.similarityScore) {
      return right.similarityScore - left.similarityScore;
    }
    return left.groupIdentifier < right.groupIdentifier ? -1 : 1;
  });

  return {
    cases: scored.slice(0, limit),
    bucketKey,
    isRootCauseConfidence: false,
    similarityThreshold: minimumSimilarity,
    limit,
  };
}

/** 组成员 → 相似案例（供上层把组内成员也作为候选展示时使用）。 */
export function toRelatedCase(group: DiagnosticClusterGroup, similarityScore: number): DiagnosticRelatedCase {
  return {
    groupIdentifier: group.groupIdentifier,
    representativeSourceRecordIdentifier: group.representativeSourceRecordIdentifier,
    similarityScore,
    memberCount: group.memberCount,
    firstRecordedAtIso: group.firstRecordedAtIso,
    lastRecordedAtIso: group.lastRecordedAtIso,
  };
}
