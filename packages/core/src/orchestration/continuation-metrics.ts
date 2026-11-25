/**
 * RESUME-02 补口（2026-11-25）：断点续接的**观测计数**（进程内、有界、只读快照）。
 *
 * 卡内要求："持久记录恢复意图、对账判定、租约、上下文装配字节/token 估计与引用、派发回执；
 * 不记录秘密或隐藏思维链"。本模块只做**聚合计数**（不记录任务正文/参数/凭据），
 * 用于回答"续接尝试了多少次、被什么原因挡住"；持久化由调用方决定（不在此写盘）。
 *
 * 纪律：
 * - 维度有界：outcome 固定枚举 + reasonCode 最多 32 个不同值，超出归入 `other`（防内存膨胀）；
 * - 每次观测只加一次（不重复计数）；快照是**冻结副本**，调用方改不动内部状态；
 * - 不记录任何任务正文、参数、路径、凭据（只记枚举与原因码）。
 */

export type ContinuationMetricOutcome =
  | "resumed"
  | "blocked"
  | "claimed"
  | "already-claimed"
  | "still-running"
  | "needs-selection"
  | "needs-answer"
  | "needs-authorization"
  | "reconciling"
  | "waiting-provider"
  | "nothing-to-resume"
  | "disabled"
  | "cancelled"
  | "unknown";

export interface ContinuationMetricObservation {
  readonly outcome: ContinuationMetricOutcome;
  /** 原因码（来自业务层）；不参与计数的正文/参数**不得**传进来。 */
  readonly reasonCode?: string | null;
}

export interface ContinuationMetricEntry {
  readonly outcome: ContinuationMetricOutcome;
  readonly reasonCode: string | null;
  readonly count: number;
}

export interface ContinuationMetricSnapshot {
  readonly total: number;
  readonly entries: readonly ContinuationMetricEntry[];
}

const MAXIMUM_DISTINCT_REASON_CODES = 32;
const OTHER_REASON_CODE = "other";

export class ContinuationMetrics {
  private readonly counts = new Map<string, number>();
  private readonly distinctReasonCodes = new Set<string>();
  private total = 0;

  record(observation: ContinuationMetricObservation): void {
    const normalizedReasonCode = this.normalizeReasonCode(observation.reasonCode);
    const key = `${observation.outcome}\u0000${normalizedReasonCode ?? ""}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.total += 1;
  }

  snapshot(): ContinuationMetricSnapshot {
    const entries: ContinuationMetricEntry[] = [];
    for (const [key, count] of this.counts) {
      const separatorIndex = key.indexOf("\u0000");
      const outcome = key.slice(0, separatorIndex) as ContinuationMetricOutcome;
      const reasonCode = key.slice(separatorIndex + 1);
      entries.push({
        outcome,
        reasonCode: reasonCode === "" ? null : reasonCode,
        count,
      });
    }
    entries.sort((left, right) => {
      if (left.outcome !== right.outcome) return left.outcome < right.outcome ? -1 : 1;
      const leftReason = left.reasonCode ?? "";
      const rightReason = right.reasonCode ?? "";
      return leftReason < rightReason ? -1 : leftReason > rightReason ? 1 : 0;
    });
    return Object.freeze({
      total: this.total,
      entries: Object.freeze(entries),
    });
  }

  reset(): void {
    this.counts.clear();
    this.distinctReasonCodes.clear();
    this.total = 0;
  }

  private normalizeReasonCode(reasonCode: string | null | undefined): string | null {
    if (reasonCode === null || reasonCode === undefined) return null;
    const trimmed = reasonCode.trim();
    if (trimmed === "") return null;
    if (this.distinctReasonCodes.has(trimmed)) return trimmed;
    if (this.distinctReasonCodes.size >= MAXIMUM_DISTINCT_REASON_CODES) {
      /** 有界：新原因码一律归入 other，避免任意原因码把内存打爆。 */
      return OTHER_REASON_CODE;
    }
    this.distinctReasonCodes.add(trimmed);
    return trimmed;
  }
}
