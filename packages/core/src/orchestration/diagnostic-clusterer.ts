import type { DiagnosticEvent } from "./diagnostic-event-store.js";

/**
 * CLUSTER-01 §3：**纯聚类算法**（无 IO、无模型、无第三方依赖）。
 *
 * 三条铁律（卡内原文）：
 * - 相似 ≠ 同因 ≠ 工作流等价 ⇒ 只产出"相似问题组"，不产出原因断言；
 * - **严格分桶**：键不同的记录永不聚合，`null` 保持未知（不得推断成某个错误码）；
 * - **不做传递合并**：只与各组**代表成员**比较，A 近 B、B 近 C 不导致 A 与 C 同组。
 */

/** §3 第 4 条：文本规范化版本号。改规则必须升级版本，否则索引无法自证。 */
export const DIAGNOSTIC_TEXT_NORMALIZATION_VERSION = "diagnostic-text-v1";

/** §3 第 6 条：相似度阈值。 */
export const DIAGNOSTIC_CLUSTER_SIMILARITY_THRESHOLD = 0.85;

const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * 聚类输入：只带聚类需要的字段，避免把整个事件结构耦合进算法。
 *
 * `sourceRecordIdentifier` 取"请求标识 + 请求 revision"——单用请求标识会因重试而重复，
 * 加上 revision 才能保证"同一次记录"稳定且唯一。
 */
export interface DiagnosticClusterInput {
  readonly sourceRecordIdentifier: string;
  readonly recordedAtIso: string;
  readonly projectIdentifier: string | null;
  readonly errorCode: string;
  readonly component: string;
  readonly stage: string;
  readonly classification: string | null;
  readonly chain: {
    readonly rootErrorCode: string | null;
    readonly wrapperErrorCodes: readonly string[];
  };
  readonly messageText: string;
}

/**
 * 适配器：事件里**没有**项目字段，项目归属由本地可信关系索引核验后**由调用方传入**
 * （§3 第 1 条：不接受模型自填项目 ID 作为凭证）。
 */
export function toDiagnosticClusterInput(
  event: DiagnosticEvent,
  projectIdentifier: string | null,
): DiagnosticClusterInput {
  return {
    sourceRecordIdentifier: `${event.requestIdentifier}#${String(event.requestRevision)}`,
    recordedAtIso: event.recordedAtIso,
    projectIdentifier,
    errorCode: event.errorCode,
    component: event.component,
    stage: event.stage,
    classification: event.classification ?? null,
    chain: {
      rootErrorCode: event.chain.rootErrorCode,
      wrapperErrorCodes: [...event.chain.wrapperErrorCodes],
    },
    messageText: event.messageText,
  };
}

/**
 * `diagnostic-text-v1`：Unicode NFC、统一换行与连续空白；
 * **只**替换明确的 ISO 时间戳与 UUID。
 *
 * 刻意不做（卡内明令禁止）：泛化任意数字/状态码/路径/变量名/包名、全局大小写折叠。
 */
export function normalizeDiagnosticText(text: string): string {
  return text
    .normalize("NFC")
    .replace(UUID_PATTERN, "<uuid>")
    .replace(ISO_TIMESTAMP_PATTERN, "<timestamp>")
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n+/gu, "\n")
    .trim();
}

/** §3 第 5 条：Unicode 码点连续三元组集合。 */
export function computeTrigramSet(text: string): Set<string> {
  const codePoints = [...text];
  /** 不足三个码点 ⇒ 用完整文本作为一个特征。 */
  if (codePoints.length < 3) {
    return new Set(codePoints.length === 0 ? [] : [text]);
  }
  const trigrams = new Set<string>();
  for (let index = 0; index + 2 < codePoints.length; index += 1) {
    trigrams.add(codePoints[index]! + codePoints[index + 1]! + codePoints[index + 2]!);
  }
  return trigrams;
}

/** §3 第 5 条：Jaccard = 交集大小 / 并集大小。 */
export function computeJaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersectionSize = 0;
  for (const feature of left) {
    if (right.has(feature)) intersectionSize += 1;
  }
  const unionSize = left.size + right.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/** §3 第 3 条：严格分桶键。`null` 保持"未知"，与具体值绝不同桶。 */
export function buildDiagnosticBucketKey(event: DiagnosticClusterInput): string {
  const bucketParts = [
    event.projectIdentifier ?? "<null>",
    event.errorCode,
    event.component,
    event.stage,
    event.classification ?? "<null>",
    event.chain.rootErrorCode ?? "<null>",
    event.chain.wrapperErrorCodes.length === 0 ? "-" : event.chain.wrapperErrorCodes.join(">"),
  ];
  /** 用不可出现在标识符里的分隔符，避免拼接歧义。 */
  return bucketParts.join("\u0000");
}

export interface DiagnosticClusterMember {
  readonly sourceRecordIdentifier: string;
  readonly recordedAtIso: string;
  readonly normalizedText: string;
  readonly similarityToRepresentative: number;
}

export interface DiagnosticClusterGroup {
  readonly groupIdentifier: string;
  readonly bucketKey: string;
  readonly representativeSourceRecordIdentifier: string;
  readonly members: readonly DiagnosticClusterMember[];
  /** 完全相同的规范化文本去重后的条数（§3 第 5 条）。 */
  readonly distinctTextCount: number;
  readonly memberCount: number;
  readonly firstRecordedAtIso: string;
  readonly lastRecordedAtIso: string;
}

export interface DiagnosticClusterResult {
  readonly groups: readonly DiagnosticClusterGroup[];
  readonly normalizationVersion: string;
  readonly similarityThreshold: number;
}

/**
 * §3 第 6 条：桶内按 `recordedAtIso`、`sourceRecordIdentifier` 排序后，
 * 依次与已有组的**首个成员**比较；最高分 ≥ 阈值则加入（并列取代表 ID 字典序最小的组），
 * 否则新建组。
 */
export function clusterDiagnosticEvents(
  events: readonly DiagnosticClusterInput[],
  options: { readonly similarityThreshold?: number } = {},
): DiagnosticClusterResult {
  const threshold = options.similarityThreshold ?? DIAGNOSTIC_CLUSTER_SIMILARITY_THRESHOLD;
  const buckets = new Map<string, DiagnosticClusterInput[]>();
  for (const event of events) {
    const bucketKey = buildDiagnosticBucketKey(event);
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      buckets.set(bucketKey, [event]);
    } else {
      bucket.push(event);
    }
  }

  const groups: DiagnosticClusterGroup[] = [];
  for (const [bucketKey, bucketEvents] of buckets) {
    const ordered = [...bucketEvents].sort((left, right) => {
      if (left.recordedAtIso !== right.recordedAtIso) {
        return left.recordedAtIso < right.recordedAtIso ? -1 : 1;
      }
      return left.sourceRecordIdentifier < right.sourceRecordIdentifier ? -1 : 1;
    });

    const openGroups: Array<{
      representative: DiagnosticClusterInput;
      representativeTrigrams: Set<string>;
      members: DiagnosticClusterMember[];
    }> = [];

    for (const event of ordered) {
      const normalizedText = normalizeDiagnosticText(event.messageText);
      const trigrams = computeTrigramSet(normalizedText);
      let bestGroupIndex = -1;
      let bestScore = 0;
      for (let groupIndex = 0; groupIndex < openGroups.length; groupIndex += 1) {
        const candidate = openGroups[groupIndex]!;
        const score =
          normalizedText === candidate.members[0]!.normalizedText
            ? 1
            : computeJaccardSimilarity(trigrams, candidate.representativeTrigrams);
        const isBetter = score > bestScore;
        const isTiedButSmallerId =
          score === bestScore &&
          score >= threshold &&
          bestGroupIndex !== -1 &&
          candidate.representative.sourceRecordIdentifier <
            openGroups[bestGroupIndex]!.representative.sourceRecordIdentifier;
        if (isBetter || isTiedButSmallerId) {
          bestScore = score;
          bestGroupIndex = groupIndex;
        }
      }

      const canJoin = bestGroupIndex !== -1 && bestScore >= threshold;
      if (!canJoin) {
        openGroups.push({
          representative: event,
          representativeTrigrams: trigrams,
          members: [
            {
              sourceRecordIdentifier: event.sourceRecordIdentifier,
              recordedAtIso: event.recordedAtIso,
              normalizedText,
              similarityToRepresentative: 1,
            },
          ],
        });
        continue;
      }
      openGroups[bestGroupIndex]!.members.push({
        sourceRecordIdentifier: event.sourceRecordIdentifier,
        recordedAtIso: event.recordedAtIso,
        normalizedText,
        similarityToRepresentative: bestScore,
      });
    }

    for (const group of openGroups) {
      const timestamps = group.members.map((member) => member.recordedAtIso).sort();
      groups.push({
        groupIdentifier: `${bucketKey}\u0000${group.representative.sourceRecordIdentifier}`,
        bucketKey,
        representativeSourceRecordIdentifier: group.representative.sourceRecordIdentifier,
        members: group.members,
        distinctTextCount: new Set(group.members.map((member) => member.normalizedText)).size,
        memberCount: group.members.length,
        firstRecordedAtIso: timestamps[0] ?? group.representative.recordedAtIso,
        lastRecordedAtIso: timestamps[timestamps.length - 1] ?? group.representative.recordedAtIso,
      });
    }
  }

  return { groups, normalizationVersion: DIAGNOSTIC_TEXT_NORMALIZATION_VERSION, similarityThreshold: threshold };
}
