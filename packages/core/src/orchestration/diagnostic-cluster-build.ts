import type { DiagnosticEvent, DiagnosticEventStore } from "./diagnostic-event-store.js";
import {
  buildDiagnosticBucketKey,
  clusterDiagnosticEvents,
  toDiagnosticClusterInput,
  type DiagnosticClusterInput,
} from "./diagnostic-clusterer.js";
import {
  buildDiagnosticClusterSnapshot,
  type DiagnosticClusterSnapshot,
} from "./diagnostic-cluster-index.js";
import type { DiagnosticPageCursor } from "./diagnostic-event-page-reader.js";

/**
 * CLUSTER-01 §4：把「扫描 → 聚类 → 生成快照」串起来的**构建器**。
 *
 * 卡内硬约束：
 * - 每批 200 行、每次最多 2,000 条有效事件 / 16 MiB、运行最多 5,000 ms、相似比较最多 100,000 次；
 * - **命中任何上限即保存游标并返回 partial 与具体原因**，不得声称覆盖全部历史；
 * - 项目归属由**调用方的可信关系索引**判定（不接受模型自填），无法证明归属的记录排除并计数。
 */

export const DIAGNOSTIC_CLUSTER_BUILD_LIMITS = {
  pageSize: 200,
  maximumEventCount: 2_000,
  maximumBytes: 16 * 1024 * 1024,
  maximumDurationMilliseconds: 5_000,
  maximumSimilarityComparisons: 100_000,
} as const;

export type DiagnosticClusterPartialReason =
  | "event-limit"
  | "byte-limit"
  | "duration-limit"
  | "comparison-limit"
  | "cancelled";

export interface BuildClusterSnapshotInput {
  readonly store: DiagnosticEventStore;
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  readonly algorithmVersion: string;
  readonly generatedAtIso: string;
  readonly cursor?: DiagnosticPageCursor;
  /** 可信归属判定：返回 null 表示"归属无法证明"⇒ 排除并计数。 */
  readonly resolveProjectIdentifier: (event: DiagnosticEvent) => string | null;
  readonly limits?: Partial<Record<keyof typeof DIAGNOSTIC_CLUSTER_BUILD_LIMITS, number>>;
  readonly nowMilliseconds?: () => number;
  /** 取消信号：命中即停止扫描、保存游标，返回 partial 原因 `cancelled`。 */
  readonly signal?: AbortSignal;
}

export interface BuildClusterSnapshotResult {
  readonly snapshot: DiagnosticClusterSnapshot;
  readonly scannedEventCount: number;
  readonly excludedRecordCount: number;
  readonly partialReason: DiagnosticClusterPartialReason | null;
}

export async function buildDiagnosticClusterSnapshotForProject(
  input: BuildClusterSnapshotInput,
): Promise<BuildClusterSnapshotResult> {
  const limits = { ...DIAGNOSTIC_CLUSTER_BUILD_LIMITS, ...input.limits };
  const now = input.nowMilliseconds ?? (() => Date.now());
  const startedAt = now();
  let cursor = input.cursor ?? { byteOffset: 0, lineNumber: 0 };
  const accepted: DiagnosticClusterInput[] = [];
  let excludedRecordCount = 0;
  let partialReason: DiagnosticClusterPartialReason | null = null;
  let isComplete = false;

  while (!isComplete) {
    if (input.signal?.aborted === true) {
      partialReason = "cancelled";
      break;
    }
    if (now() - startedAt >= limits.maximumDurationMilliseconds) {
      partialReason = "duration-limit";
      break;
    }
    const page = await input.store.readEventPages({
      cursor,
      limit: limits.pageSize,
      maximumTotalEvents: limits.maximumEventCount,
      maximumTotalBytes: limits.maximumBytes,
    });
    for (const eventPage of page.pages) {
      for (const event of eventPage.events) {
        const projectIdentifier = input.resolveProjectIdentifier(event);
        if (projectIdentifier === null || projectIdentifier !== input.projectIdentifier) {
          excludedRecordCount += 1;
          continue;
        }
        accepted.push(toDiagnosticClusterInput(event, projectIdentifier));
        if (accepted.length >= limits.maximumEventCount) {
          partialReason = "event-limit";
          break;
        }
      }
      if (partialReason !== null) break;
    }
    cursor = page.nextCursor;
    isComplete = page.isComplete && partialReason === null;
    if (partialReason !== null) break;
  }

  /** 相似比较次数上限：聚类是 O(成员 × 组)，用事件数 × 组数估算实际比较量。 */
  const bucketCount = new Set(accepted.map((event) => buildDiagnosticBucketKey(event))).size;
  const estimatedComparisons = accepted.length * Math.max(1, bucketCount);
  let clusteringResult = clusterDiagnosticEvents(accepted);
  if (estimatedComparisons > limits.maximumSimilarityComparisons) {
    /** 超限时**不谎称完整**：只保留已算出的部分并标 partial。 */
    partialReason = "comparison-limit";
    clusteringResult = clusterDiagnosticEvents(
      accepted.slice(0, Math.max(1, Math.floor(limits.maximumSimilarityComparisons / Math.max(1, bucketCount)))),
    );
  }

  const snapshot = buildDiagnosticClusterSnapshot({
    algorithmVersion: input.algorithmVersion,
    projectIdentifier: input.projectIdentifier,
    generatedAtIso: input.generatedAtIso,
    cursor,
    isComplete: partialReason === null && isComplete,
    ...(partialReason === null ? {} : { partialReason }),
    groups: clusteringResult.groups,
    configuration: {
      pageSize: limits.pageSize,
      maximumEventCount: limits.maximumEventCount,
      maximumBytes: limits.maximumBytes,
      maximumDurationMilliseconds: limits.maximumDurationMilliseconds,
      similarityThreshold: clusteringResult.similarityThreshold,
      normalizationVersion: clusteringResult.normalizationVersion,
    },
  });

  return {
    snapshot,
    scannedEventCount: accepted.length,
    excludedRecordCount,
    partialReason: snapshot.isComplete ? null : partialReason,
  };
}
