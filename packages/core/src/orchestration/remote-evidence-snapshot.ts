/**
 * REMOTE-01-01（2026-10-28）：**受控运行记录快照（EvidenceSnapshot）**。
 *
 * 卡内要求：增加 `requestRunEvidence` 操作，经项目控制面出具**不可变**快照；
 * 绑定 requestIdentifier / projectIdentifier / conversationIdentifier / 选定 messageIdentifiers /
 * 时间区间 / snapshotRevision / capturedAt / lastObservedAt / sourceAgentInstanceIdentifiers /
 * 来源类型 / 记录引用。
 *
 * 来源必须**分开登记**：用户原话、模型自述、工具调用、真实工具结果、产物登记、审查结论；
 * 没有证据的写 `unknown`；`done` 与"验收通过"分开。
 * 遗漏/脱敏/截断要**显式标记**；只包含已保存可展示记录，**不生成或索取模型隐藏思维链**。
 * 默认原文摘录；摘要必须独立注明**派生**与覆盖范围，不冒充原始回执。
 * 项目离线提供 last-known，**禁止标实时**。
 *
 * 本模块只做**纯构造**（不读盘、不发网络）：调用方把"已保存的可展示记录"传进来，
 * 这里负责排序、截断、来源标注、内容哈希与不可变语义。
 *
 * **脱敏边界**：本模块**不做**脱敏（默认原文摘录）；脱敏属投递侧，且必须由外发门禁
 * （SEC-02-04）复核并在内容变化时生成新 revision。条目上的 `isRedacted` 只是记录
 * "这条在入库时已被脱敏"的事实，不得用它冒充"已通过外发检查"。
 */
import { createHash } from "node:crypto";

/** 快照 schema 版本（字段变动即递增）。 */
export const EVIDENCE_SNAPSHOT_SCHEMA_VERSION = 1;

/** 单条摘录的最大字符数（超出即截断并标记）。 */
export const MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS = 600;

export type EvidenceSourceKind =
  | "user-message"
  | "model-claim"
  | "tool-call"
  | "tool-result"
  | "artifact-registration"
  | "review-conclusion"
  | "unknown";

export interface EvidenceSnapshotRequest {
  readonly requestIdentifier: string;
  readonly projectIdentifier: string;
  readonly conversationIdentifier: string | null;
  readonly missionIdentifiers: readonly string[];
  /** 选定的消息标识（为空表示未按消息过滤）。 */
  readonly messageIdentifiers?: readonly string[];
  readonly fromIso?: string;
  readonly toIso?: string;
}

export interface EvidenceSnapshotCandidateEntry {
  readonly entryIdentifier: string;
  readonly sourceKind: EvidenceSourceKind;
  readonly sourceAgentInstanceIdentifier: string | null;
  readonly recordedAtIso: string;
  readonly recordReference: string;
  /** 已保存的原文摘录；**不得**包含模型隐藏思维链。 */
  readonly excerptText: string;
  readonly isRedacted?: boolean;
  /** 该条本身是否来自摘要（摘要必须独立注明派生）。 */
  readonly isSummaryDerived?: boolean;
  /** 生成该摘要时覆盖的条目数（仅摘要条目使用）。 */
  readonly summaryCoveredEntryCount?: number;
}

export interface EvidenceSnapshotEntry {
  readonly entryIdentifier: string;
  readonly sourceKind: EvidenceSourceKind;
  readonly sourceAgentInstanceIdentifier: string | null;
  readonly recordedAtIso: string;
  readonly recordReference: string;
  readonly excerptText: string;
  readonly isRedacted: boolean;
  readonly isTruncated: boolean;
  readonly isSummaryDerived: boolean;
  readonly summaryCoveredEntryCount: number | null;
}

export interface EvidenceSnapshot {
  readonly schemaVersion: typeof EVIDENCE_SNAPSHOT_SCHEMA_VERSION;
  readonly requestIdentifier: string;
  readonly snapshotRevision: number;
  readonly projectIdentifier: string;
  readonly conversationIdentifier: string | null;
  readonly missionIdentifiers: readonly string[];
  readonly capturedAtIso: string;
  /** 数据里最新一条记录的时间（不是"现在"）。 */
  readonly lastObservedAtIso: string;
  /** 恒 false：本地快照是 last-known，不是实时流。 */
  readonly isRealtime: false;
  readonly sourceAgentInstanceIdentifiers: readonly string[];
  readonly sourceKinds: readonly EvidenceSourceKind[];
  readonly entries: readonly EvidenceSnapshotEntry[];
  readonly omissions: {
    readonly omittedEntryCount: number;
    readonly truncatedEntryCount: number;
    readonly redactedEntryCount: number;
    readonly reasonCodes: readonly string[];
  };
  /** 规范化 JSON 的 SHA-256（不含本字段自身）。 */
  readonly contentHash: string;
}

export interface BuildEvidenceSnapshotInput {
  readonly request: EvidenceSnapshotRequest;
  readonly candidateEntries: readonly EvidenceSnapshotCandidateEntry[];
  /** 快照 revision：由存储/发布方给，不由本函数猜测。 */
  readonly snapshotRevision: number;
  readonly capturedAtIso: string;
  /** 额外遗漏原因（例如某些来源未装配），随 `omissions.reasonCodes` 一并返回。 */
  readonly additionalReasonCodes?: readonly string[];
}

/** 构造不可变快照（确定性：同输入同哈希）。 */
export function buildEvidenceSnapshot(
  input: BuildEvidenceSnapshotInput,
): EvidenceSnapshot {
  if (input.request.requestIdentifier.trim() === "") {
    throw new Error("证据快照必须绑定 requestIdentifier");
  }
  if (input.request.projectIdentifier.trim() === "") {
    throw new Error("证据快照必须绑定 projectIdentifier");
  }
  if (input.request.missionIdentifiers.length === 0) {
    throw new Error("证据快照至少需要一个 mission 标识");
  }
  const timeRange = resolveTimeRange(input.request);
  const reasonCodes: string[] = [];
  const selectedEntries: EvidenceSnapshotCandidateEntry[] = [];
  let omittedEntryCount = 0;
  let truncatedEntryCount = 0;
  let redactedEntryCount = 0;
  for (const candidate of input.candidateEntries) {
    if (!isWithinTimeRange(candidate.recordedAtIso, timeRange)) {
      omittedEntryCount += 1;
      continue;
    }
    selectedEntries.push(candidate);
  }
  if (omittedEntryCount > 0) {
    reasonCodes.push("time-range-outside");
  }
  /**
   * 排序：时间升序 + 标识升序（同输入永远得到同一顺序，保证哈希可复现）。
   */
  selectedEntries.sort((left, right) => {
    if (left.recordedAtIso !== right.recordedAtIso) {
      return left.recordedAtIso < right.recordedAtIso ? -1 : 1;
    }
    return left.entryIdentifier.localeCompare(right.entryIdentifier);
  });
  const entries: EvidenceSnapshotEntry[] = selectedEntries.map((candidate) => {
    const isTruncated =
      candidate.excerptText.length > MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS;
    if (isTruncated) {
      truncatedEntryCount += 1;
    }
    const isRedacted = candidate.isRedacted === true;
    if (isRedacted) {
      redactedEntryCount += 1;
    }
    return {
      entryIdentifier: candidate.entryIdentifier,
      sourceKind: candidate.sourceKind,
      sourceAgentInstanceIdentifier: candidate.sourceAgentInstanceIdentifier,
      recordedAtIso: candidate.recordedAtIso,
      recordReference: candidate.recordReference,
      excerptText: isTruncated
        ? candidate.excerptText.slice(0, MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS)
        : candidate.excerptText,
      isRedacted,
      isTruncated,
      isSummaryDerived: candidate.isSummaryDerived === true,
      summaryCoveredEntryCount:
        candidate.isSummaryDerived === true
          ? (candidate.summaryCoveredEntryCount ?? null)
          : null,
    };
  });
  if (truncatedEntryCount > 0) {
    reasonCodes.push("excerpt-truncated");
  }
  if (redactedEntryCount > 0) {
    reasonCodes.push("content-redacted");
  }
  const lastObservedAtIso = latestRecordedAt(entries, input.capturedAtIso);
  for (const reasonCode of input.additionalReasonCodes ?? []) {
    if (!reasonCodes.includes(reasonCode)) {
      reasonCodes.push(reasonCode);
    }
  }
  const sourceKinds = [...new Set(entries.map((entry) => entry.sourceKind))].sort();
  const sourceAgentInstanceIdentifiers = [
    ...new Set(
      entries
        .map((entry) => entry.sourceAgentInstanceIdentifier)
        .filter((identifier): identifier is string => identifier !== null),
    ),
  ].sort();

  const snapshotWithoutHash: Omit<EvidenceSnapshot, "contentHash"> = {
    schemaVersion: EVIDENCE_SNAPSHOT_SCHEMA_VERSION,
    requestIdentifier: input.request.requestIdentifier,
    snapshotRevision: input.snapshotRevision,
    projectIdentifier: input.request.projectIdentifier,
    conversationIdentifier: input.request.conversationIdentifier,
    missionIdentifiers: [...input.request.missionIdentifiers].sort(),
    capturedAtIso: input.capturedAtIso,
    lastObservedAtIso,
    isRealtime: false as const,
    sourceAgentInstanceIdentifiers,
    sourceKinds,
    entries,
    omissions: {
      omittedEntryCount,
      truncatedEntryCount,
      redactedEntryCount,
      reasonCodes,
    },
  };
  const contentHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(snapshotWithoutHash))
    .digest("hex")}`;
  return { ...snapshotWithoutHash, contentHash };
}

/** 校验快照内容未被改动（重算哈希比对）。 */
export function verifyEvidenceSnapshotIntegrity(snapshot: EvidenceSnapshot): boolean {
  const { contentHash, ...rest } = snapshot;
  const recomputed = `sha256:${createHash("sha256")
    .update(JSON.stringify(rest))
    .digest("hex")}`;
  return recomputed === contentHash;
}

function resolveTimeRange(request: EvidenceSnapshotRequest): {
  fromMilliseconds: number | null;
  toMilliseconds: number | null;
} {
  const fromMilliseconds =
    request.fromIso === undefined ? null : Date.parse(request.fromIso);
  const toMilliseconds =
    request.toIso === undefined ? null : Date.parse(request.toIso);
  if (fromMilliseconds !== null && Number.isNaN(fromMilliseconds)) {
    throw new Error(`证据快照 fromIso 非法: ${request.fromIso}`);
  }
  if (toMilliseconds !== null && Number.isNaN(toMilliseconds)) {
    throw new Error(`证据快照 toIso 非法: ${request.toIso}`);
  }
  if (
    fromMilliseconds !== null &&
    toMilliseconds !== null &&
    fromMilliseconds > toMilliseconds
  ) {
    throw new Error("证据快照时间区间非法（fromIso 晚于 toIso）");
  }
  return { fromMilliseconds, toMilliseconds };
}

function isWithinTimeRange(
  recordedAtIso: string,
  timeRange: { fromMilliseconds: number | null; toMilliseconds: number | null },
): boolean {
  const recordedAtMilliseconds = Date.parse(recordedAtIso);
  if (Number.isNaN(recordedAtMilliseconds)) {
    return false;
  }
  if (
    timeRange.fromMilliseconds !== null &&
    recordedAtMilliseconds < timeRange.fromMilliseconds
  ) {
    return false;
  }
  if (
    timeRange.toMilliseconds !== null &&
    recordedAtMilliseconds > timeRange.toMilliseconds
  ) {
    return false;
  }
  return true;
}

function latestRecordedAt(
  entries: readonly EvidenceSnapshotEntry[],
  fallbackIso: string,
): string {
  let latestIso = "";
  for (const entry of entries) {
    if (entry.recordedAtIso > latestIso) {
      latestIso = entry.recordedAtIso;
    }
  }
  return latestIso === "" ? fallbackIso : latestIso;
}
