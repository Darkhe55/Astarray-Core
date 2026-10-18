/**
 * HISTORY-01-03（2026-10-18）：运行历史的**只读视图层**（分页 / 过滤 / 安全渲染 / 显示开关）。
 *
 * 依据 `docs/tasks/HISTORY01_LOCAL_RUN_HISTORY_AND_RESUME_VIEW_TASK_CARD.md`：
 * - §3：「resume 读取持久记录后追加新运行段，标出**恢复分界**……**查看任意历史绝不触发工具重放**」；
 * - §4：「显示设置包括 showRunHistory（默认 true）、showProcessExplanations（默认 false）、
 *   showToolCalls（默认 true）……**关闭总显示开关只隐藏历史区……不影响采集**」；
 * - §4：「历史 HTML/Markdown、ANSI/终端控制序列、文件链接和媒体均按**不可信输入**安全渲染：
 *   不执行脚本、控制字符或自动加载远端资源」；
 * - §5：「按**游标分页**、虚拟列表、延迟展开与分块检索；游标绑定会话/过滤/版本并处理追加，
 *   不因新事件重复或漏页」；
 * - §1：没有过程说明时写「该运行未提供过程说明」，不是空白假装完整。
 *
 * ## 本模块的边界（刻意保持窄）
 *
 * - **只读**：只接收已解析的 `RunHistoryDocument`，或按目录枚举后**只读文件**；
 *   不写、不删、不追加、不恢复 mission、不调模型、不注入上下文、不重放工具。
 * - **显示设置只影响视图**：被隐藏的条目仍计入 `storedEventCount`/`hiddenEventCount`，
 *   磁盘文档不变（`RunHistoryStore.read()` 仍能读回全部事件）。
 * - **不可信文本**：所有展示文本经 `sanitizeRunHistoryDisplayText()` 处理 ——
 *   移除 ANSI/控制序列并留下显式占位，不把控制字节交给终端。
 *   **边界（写清以免被误用）**：本层保证「不含控制序列」，**不**做 HTML/Markdown 转义
 *   （转义会破坏命令行里的 `<`、`&` 等正常文本）。因此渲染方必须把这些文本当**纯文本**
 *   插入（浏览器用 `textContent`/`innerText`，**禁止** `innerHTML`），也不得据此自动加载
 *   远端资源或执行链接 —— 卡内 §4 的其余要求属渲染方义务，本层不能替代。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  resolveRunHistoryFilePath,
  validateRunHistoryDocument,
  type RunHistoryDocument,
  type RunHistoryEvent,
  type RunHistoryEventKind,
} from "./run-history-store.js";

/** 文档与事件种类随视图一起公开（消费者不必去 import 数据层模块）。 */
export type { RunHistoryDocument, RunHistoryEventKind } from "./run-history-store.js";

/** 默认页大小（与 GUI 历史列表的保守值同口径）。 */
export const DEFAULT_RUN_HISTORY_PAGE_SIZE = 20;

/** 单页硬上限：请求再大也夹到该值（防「一次全要」）。 */
export const MAXIMUM_RUN_HISTORY_PAGE_SIZE = 100;

/** 单条详情文本上限：超出即截断并显式标记（不静默丢内容）。 */
export const MAXIMUM_RUN_HISTORY_DETAIL_CHARACTERS = 4_000;

/** 控制序列被移除后的**可见占位**（保留「此处曾有内容」的事实）。 */
export const REMOVED_CONTROL_SEQUENCE_PLACEHOLDER = "[控制序列已移除]";

/** 没有过程说明时的固定文案（卡内 §1 指定）。 */
export const MISSING_PROCESS_EXPLANATION_NOTICE = "该运行未提供过程说明";

/** 过程说明被显示设置隐藏时的文案（强调**仍保存在本地**）。 */
export const HIDDEN_PROCESS_EXPLANATION_NOTICE =
  "过程说明按显示设置隐藏（仍保存在本地，不会被删除）";

/** 总显示开关关闭时的文案。 */
export const HIDDEN_RUN_HISTORY_NOTICE =
  "运行历史按显示设置隐藏（仍保存在本地，不会被删除）";

/** 显示设置（卡内 §4 的三个开关，默认值逐字对齐）。 */
export interface RunHistoryDisplaySettings {
  showRunHistory: boolean;
  showProcessExplanations: boolean;
  showToolCalls: boolean;
}

/** 默认显示设置（卡内 §4：true / false / true）。 */
export const DEFAULT_RUN_HISTORY_DISPLAY_SETTINGS: RunHistoryDisplaySettings = {
  showRunHistory: true,
  showProcessExplanations: false,
  showToolCalls: true,
};

/** 事件种类的固定取值（供 CLI/文档做参数校验，避免各处手抄）。 */
export const RUN_HISTORY_EVENT_KINDS: ReadonlyArray<RunHistoryEventKind> = [
  "tool-call",
  "tool-failure",
  "model-note",
  "checkpoint",
  "resume-boundary",
];

/** 事件种类的**稳定文本标签**（状态不只靠颜色，卡内 §4）。 */
const EVENT_KIND_LABELS: Readonly<Record<RunHistoryEventKind, string>> = {
  "tool-call": "工具调用",
  "tool-failure": "工具失败",
  "model-note": "过程说明",
  checkpoint: "检查点",
  "resume-boundary": "恢复分界",
};

/** 时间线条目（已脱敏、已标注来源段与序号）。 */
export interface RunHistoryTimelineEntry {
  /** 全 mission 内 1 起的**稳定序号**（跨段累加；游标语义基于它）。 */
  sequenceNumber: number;
  /** 所属运行段（resume 分界开新段）。 */
  segmentRevision: number;
  kind: RunHistoryEventKind;
  kindLabel: string;
  recordedAtIso: string;
  /** 事件去重键（可回指磁盘记录）。 */
  eventIdentifier: string;
  /** 已脱敏的详情文本。 */
  detailText: string;
  /** payload 不是合法 JSON ⇒ 如实标记（不伪造结构化字段）。 */
  isPayloadUnreadable: boolean;
  /** 详情文本因超长被截断 ⇒ 如实标记。 */
  isDetailTruncated: boolean;
}

/** 一页时间线。 */
export interface RunHistoryTimelinePage {
  missionIdentifier: string;
  /** 总显示开关关闭 ⇒ true（条目为空，但计数仍如实报告）。 */
  isHiddenByDisplaySettings: boolean;
  /** 需要向用户显式说明的提示（缺失/隐藏/关闭），没有则为 null。 */
  notice: string | null;
  entries: RunHistoryTimelineEntry[];
  /** 磁盘上实存的事件总数（**不受显示设置影响**）。 */
  storedEventCount: number;
  /** 通过 `includedKinds` 过滤后的事件数（仍受显示设置影响）。 */
  eligibleEventCount: number;
  /** 被显示设置隐藏的事件数（`storedEventCount - eligibleEventCount` 的可见侧对称量）。 */
  hiddenEventCount: number;
  resumeBoundaryCount: number;
  segmentCount: number;
  effectivePageSize: number;
  /** 下一页游标；无更多则为 null。 */
  nextCursor: number | null;
}

/** 运行历史文件的一条**摘要**（用于列表页，不夹带正文）。 */
export interface RunHistoryMissionSummary {
  missionIdentifier: string;
  segmentCount: number | null;
  eventCount: number | null;
  lastRecordedAtIso: string | null;
  isCorrupted: boolean;
  /** 损坏/不可读时的原因（正常为 null）。 */
  reason: string | null;
}

/** 一页运行历史列表。 */
export interface RunHistoryMissionListPage {
  entries: RunHistoryMissionSummary[];
  pageIndex: number;
  effectivePageSize: number;
  totalMissionCount: number;
  hasMorePages: boolean;
}

/**
 * 把**不可信文本**变成可安全展示的文本（卡内 §4）。
 *
 * 处理顺序（先整体移除序列、再清残留控制字节）：
 * 1. OSC（`ESC ]` … `BEL`/`ESC \`）—— 超链接等最常见的终端注入载体；
 * 2. CSI（`ESC [` … 终止符）—— 颜色、光标、清屏；
 * 3. 其余双字符 ESC 序列；
 * 4. 残留的 C0（除 `\n`/`\t`）与 C1/DEL 控制字节；
 * 5. `\r\n` 归一化为 `\n`（避免回车覆盖已显示内容）。
 */
export function sanitizeRunHistoryDisplayText(input: string): string {
  const withoutEscapeSequences = input
    // OSC：ESC ] ... （BEL 或 ST 结尾）—— 控制字符是本函数的**处理对象**，故豁免该 lint 规则
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, REMOVED_CONTROL_SEQUENCE_PLACEHOLDER)
    // CSI：ESC [ 参数 终止符
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, REMOVED_CONTROL_SEQUENCE_PLACEHOLDER)
    // 其余 ESC 双字符序列（如 ESC c 复位）
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B[@-Z\\-_]/g, REMOVED_CONTROL_SEQUENCE_PLACEHOLDER);

  const withoutControlBytes = withoutEscapeSequences.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
    "",
  );
  return withoutControlBytes.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** 单条事件的 payload ⇒ 已脱敏的详情文本。 */
export function renderRunHistoryPayloadDetail(payloadJson: string): {
  detailText: string;
  isPayloadUnreadable: boolean;
  isDetailTruncated: boolean;
} {
  let parsed: unknown;
  let isPayloadUnreadable = false;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    parsed = payloadJson;
    isPayloadUnreadable = true;
  }

  const rawText = renderParsedPayload(parsed);
  const sanitized = sanitizeRunHistoryDisplayText(rawText);
  if (sanitized.length <= MAXIMUM_RUN_HISTORY_DETAIL_CHARACTERS) {
    return { detailText: sanitized, isPayloadUnreadable, isDetailTruncated: false };
  }
  return {
    detailText: sanitized.slice(0, MAXIMUM_RUN_HISTORY_DETAIL_CHARACTERS),
    isPayloadUnreadable,
    isDetailTruncated: true,
  };
}

/**
 * payload ⇒ 人类可读文本。
 *
 * 为什么不平铺 `JSON.stringify(payload, null, 2)`：那会把字符串里的控制字节
 * 转义成 `\u001b` 六个字符，**看起来安全**却也让「被移除的注入」无法被显式标注；
 * 而按字段逐行渲染后，字符串值会以原文进入 `sanitizeRunHistoryDisplayText()`，
 * 控制序列被真正移除并留下可见占位（卡内 §4 要求显式、不可执行）。
 * 非字符串值仍走 JSON 序列化（其转义本身是安全的）。
 */
function renderParsedPayload(parsed: unknown): string {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const renderedValue =
        typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
      lines.push(`${key}: ${renderedValue}`);
    }
    return lines.join("\n");
  }
  if (typeof parsed === "string") return parsed;
  return JSON.stringify(parsed) ?? String(parsed);
}

/** 显示设置是否让某类事件可见。 */
function isEventKindVisible(
  kind: RunHistoryEventKind,
  settings: RunHistoryDisplaySettings,
): boolean {
  if (kind === "model-note") return settings.showProcessExplanations;
  if (kind === "tool-call" || kind === "tool-failure") return settings.showToolCalls;
  return true;
}

/** 把文档摊平成带稳定序号的条目（不做显示过滤）。 */
function flattenDocumentEvents(document: RunHistoryDocument): Array<{
  event: RunHistoryEvent;
  segmentRevision: number;
  sequenceNumber: number;
}> {
  const flattened: Array<{
    event: RunHistoryEvent;
    segmentRevision: number;
    sequenceNumber: number;
  }> = [];
  let sequenceNumber = 0;
  for (const segment of document.segments) {
    for (const event of segment.events) {
      sequenceNumber += 1;
      flattened.push({ event, segmentRevision: segment.segmentRevision, sequenceNumber });
    }
  }
  return flattened;
}

/**
 * 构建**一页时间线**（纯函数：不读盘、不写盘、不产生副作用）。
 *
 * 游标语义：`cursor` = 上一页最后一条的 `sequenceNumber`；只返回序号更大的条目。
 * 因此**追加新事件**不会让既有页重复或漏页（卡内 §5）。
 */
export function buildRunHistoryTimelinePage(input: {
  document: RunHistoryDocument;
  displaySettings?: Partial<RunHistoryDisplaySettings>;
  /** 只保留这些种类（缺省 = 全部）；显示设置仍可进一步隐藏。 */
  includedKinds?: ReadonlyArray<RunHistoryEventKind>;
  cursor?: number | null;
  pageSize?: number;
}): RunHistoryTimelinePage {
  const settings: RunHistoryDisplaySettings = {
    ...DEFAULT_RUN_HISTORY_DISPLAY_SETTINGS,
    ...input.displaySettings,
  };
  const flattened = flattenDocumentEvents(input.document);
  const storedEventCount = flattened.length;
  const resumeBoundaryCount = flattened.filter(
    (item) => item.event.kind === "resume-boundary",
  ).length;

  const includedKinds = input.includedKinds;
  const isKindIncluded = (kind: RunHistoryEventKind): boolean =>
    includedKinds === undefined || includedKinds.includes(kind);

  // 显示设置隐藏了多少（与 includedKinds 无关，用来看「关了但还在」）
  // 总开关关闭时**全部**都不可见，故按总开关计入隐藏数（否则"关掉一切"却报隐藏 1 条，自相矛盾）。
  const hiddenEventCount = settings.showRunHistory
    ? flattened.filter((item) => !isEventKindVisible(item.event.kind, settings)).length
    : storedEventCount;

  const eligible = settings.showRunHistory
    ? flattened.filter(
        (item) => isKindIncluded(item.event.kind) && isEventKindVisible(item.event.kind, settings),
      )
    : [];

  const hasModelNotes = flattened.some((item) => item.event.kind === "model-note");
  const notice = resolveTimelineNotice({ settings, hasModelNotes });

  const requestedPageSize =
    input.pageSize === undefined ? DEFAULT_RUN_HISTORY_PAGE_SIZE : input.pageSize;
  const effectivePageSize = clampPageSize(requestedPageSize);

  if (!settings.showRunHistory) {
    return {
      missionIdentifier: input.document.missionIdentifier,
      isHiddenByDisplaySettings: true,
      notice,
      entries: [],
      storedEventCount,
      eligibleEventCount: eligible.length,
      hiddenEventCount,
      resumeBoundaryCount,
      segmentCount: input.document.segments.length,
      effectivePageSize,
      nextCursor: null,
    };
  }

  const cursor = input.cursor ?? 0;
  const afterCursor = eligible.filter((item) => item.sequenceNumber > cursor);
  const pageItems = afterCursor.slice(0, effectivePageSize);
  const entries = pageItems.map((item) => {
    const detail = renderRunHistoryPayloadDetail(item.event.payloadJson);
    return {
      sequenceNumber: item.sequenceNumber,
      segmentRevision: item.segmentRevision,
      kind: item.event.kind,
      kindLabel: EVENT_KIND_LABELS[item.event.kind],
      recordedAtIso: item.event.recordedAtIso,
      eventIdentifier: item.event.eventIdentifier,
      detailText: detail.detailText,
      isPayloadUnreadable: detail.isPayloadUnreadable,
      isDetailTruncated: detail.isDetailTruncated,
    };
  });
  const lastEntry = entries[entries.length - 1];
  const hasMore = afterCursor.length > pageItems.length;

  return {
    missionIdentifier: input.document.missionIdentifier,
    isHiddenByDisplaySettings: false,
    notice,
    entries,
    storedEventCount,
    eligibleEventCount: eligible.length,
    hiddenEventCount,
    resumeBoundaryCount,
    segmentCount: input.document.segments.length,
    effectivePageSize,
    nextCursor: hasMore && lastEntry !== undefined ? lastEntry.sequenceNumber : null,
  };
}

function resolveTimelineNotice(input: {
  settings: RunHistoryDisplaySettings;
  hasModelNotes: boolean;
}): string | null {
  if (!input.settings.showRunHistory) return HIDDEN_RUN_HISTORY_NOTICE;
  if (input.settings.showProcessExplanations) return null;
  return input.hasModelNotes ? HIDDEN_PROCESS_EXPLANATION_NOTICE : MISSING_PROCESS_EXPLANATION_NOTICE;
}

/** 页大小夹取：非有限数/≤0 回落到默认值；超过上限夹到上限；不足 1 的夹到 1。 */
function clampPageSize(requestedPageSize: number): number {
  if (!Number.isFinite(requestedPageSize) || requestedPageSize <= 0) {
    return DEFAULT_RUN_HISTORY_PAGE_SIZE;
  }
  return Math.min(
    Math.max(1, Math.trunc(requestedPageSize)),
    MAXIMUM_RUN_HISTORY_PAGE_SIZE,
  );
}

/**
 * **只读**查询某 mission 的一页时间线（真实读盘；不写、不删、不恢复、不调模型）。
 *
 * - 文件不存在 ⇒ `kind: "absent"`（不伪造空历史冒充「跑过」）；
 * - 文档损坏/版本不认识/mission 不符 ⇒ `kind: "invalid"`（如实报，不静默跳过）。
 */
export async function queryRunHistoryTimeline(input: {
  readonly baseDirectory: string;
  readonly missionIdentifier: string;
  readonly displaySettings?: Partial<RunHistoryDisplaySettings>;
  readonly includedKinds?: ReadonlyArray<RunHistoryEventKind>;
  readonly cursor?: number | null;
  readonly pageSize?: number;
}): Promise<
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "valid"; readonly page: RunHistoryTimelinePage }
> {
  const historyFilePath = resolveHistoryFilePath(input.baseDirectory, input.missionIdentifier);
  let rawContent: string;
  try {
    rawContent = await fs.readFile(historyFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", reason: "该 mission 没有运行历史文件。" };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return { kind: "invalid", reason: "运行历史文件不是合法 JSON；按损坏处理，不伪称完整。" };
  }

  const validated = validateRunHistoryDocument(parsed);
  if (validated.kind === "invalid") return validated;
  if (validated.document.missionIdentifier !== input.missionIdentifier) {
    return { kind: "invalid", reason: "运行历史所属 mission 与请求不一致。" };
  }

  const page = buildRunHistoryTimelinePage({
    document: validated.document,
    ...(input.displaySettings === undefined
      ? {}
      : { displaySettings: input.displaySettings }),
    ...(input.includedKinds === undefined ? {} : { includedKinds: input.includedKinds }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
  });
  return { kind: "valid", page };
}

/** 与 `RunHistoryStore` 相同的文件名规则（集中一处，避免两处漂移）。 */
function resolveHistoryFilePath(baseDirectory: string, missionIdentifier: string): string {
  return resolveRunHistoryFilePath(baseDirectory, missionIdentifier);
}

/**
 * **只读**枚举运行历史文件的一页摘要（最近优先）。
 *
 * 分页按需：先 `readdir` + `stat` 取文件名与 mtime，**只对当前页**读取文件内容，
 * 因此 100 个 mission 取一页 10 条只读 10 个文件（`onHistoryRead` 可观测）。
 *
 * 损坏文件**保留在列表**并带 `isCorrupted=true`（不静默丢弃），
 * 其 `missionIdentifier` 退回文件名（文档已不可信）。
 */
export async function listRunHistoryMissions(input: {
  readonly baseDirectory: string;
  readonly pageSize?: number;
  readonly pageIndex?: number;
  readonly afterMissionIdentifier?: string;
  /** 观测端口：每读取一个历史文件时回调（测试据此断言「只读本页」）。 */
  readonly onHistoryRead?: (historyFilePath: string) => void;
}): Promise<RunHistoryMissionListPage> {
  const directory = path.join(input.baseDirectory, "run-history");
  let fileNames: string[];
  try {
    fileNames = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        entries: [],
        pageIndex: 0,
        effectivePageSize: clampPageSize(input.pageSize ?? DEFAULT_RUN_HISTORY_PAGE_SIZE),
        totalMissionCount: 0,
        hasMorePages: false,
      };
    }
    throw error;
  }

  const candidates: Array<{ fileNameBase: string; modifiedAtMilliseconds: number }> = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".json")) continue;
    const fullPath = path.join(directory, fileName);
    let statistics;
    try {
      statistics = await fs.stat(fullPath);
    } catch {
      // 竞态：枚举后文件消失 ⇒ 跳过（列表不是事实源，下一次查询会重新枚举）
      continue;
    }
    if (!statistics.isFile()) continue;
    candidates.push({
      fileNameBase: fileName.slice(0, -".json".length),
      modifiedAtMilliseconds: statistics.mtimeMs,
    });
  }

  candidates.sort((left, right) => {
    if (right.modifiedAtMilliseconds !== left.modifiedAtMilliseconds) {
      return right.modifiedAtMilliseconds - left.modifiedAtMilliseconds;
    }
    return left.fileNameBase.localeCompare(right.fileNameBase);
  });

  const effectivePageSize = clampPageSize(input.pageSize ?? DEFAULT_RUN_HISTORY_PAGE_SIZE);
  let pageStartIndex = 0;
  if (input.afterMissionIdentifier !== undefined) {
    // 游标：只返回该 mission **之后**的条目（按当前排序位置）
    const cursorIndex = candidates.findIndex(
      (candidate) => candidate.fileNameBase === input.afterMissionIdentifier,
    );
    if (cursorIndex >= 0) pageStartIndex = cursorIndex + 1;
  } else {
    pageStartIndex = clampPageIndex(input.pageIndex ?? 0) * effectivePageSize;
  }

  const pageCandidates = candidates.slice(pageStartIndex, pageStartIndex + effectivePageSize);
  const entries: RunHistoryMissionSummary[] = [];
  for (const candidate of pageCandidates) {
    const historyFilePath = path.join(directory, `${candidate.fileNameBase}.json`);
    input.onHistoryRead?.(historyFilePath);
    entries.push(await readMissionSummary(historyFilePath, candidate.fileNameBase));
  }

  return {
    entries,
    pageIndex: clampPageIndex(input.pageIndex ?? 0),
    effectivePageSize,
    totalMissionCount: candidates.length,
    hasMorePages: pageStartIndex + pageCandidates.length < candidates.length,
  };
}

function clampPageIndex(requestedPageIndex: number): number {
  if (!Number.isFinite(requestedPageIndex) || requestedPageIndex < 0) return 0;
  return Math.trunc(requestedPageIndex);
}

async function readMissionSummary(
  historyFilePath: string,
  fileNameBase: string,
): Promise<RunHistoryMissionSummary> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(historyFilePath, "utf8");
  } catch (error) {
    return {
      missionIdentifier: fileNameBase,
      segmentCount: null,
      eventCount: null,
      lastRecordedAtIso: null,
      isCorrupted: true,
      reason: `无法读取运行历史文件：${(error as NodeJS.ErrnoException).code ?? "unknown"}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return {
      missionIdentifier: fileNameBase,
      segmentCount: null,
      eventCount: null,
      lastRecordedAtIso: null,
      isCorrupted: true,
      reason: "运行历史文件不是合法 JSON（按损坏处理，不伪造完整）。",
    };
  }

  const validated = validateRunHistoryDocument(parsed);
  if (validated.kind === "invalid") {
    return {
      missionIdentifier: fileNameBase,
      segmentCount: null,
      eventCount: null,
      lastRecordedAtIso: null,
      isCorrupted: true,
      reason: validated.reason,
    };
  }

  const document = validated.document;
  const flattened = flattenDocumentEvents(document);
  const lastEvent = flattened[flattened.length - 1];
  return {
    missionIdentifier: document.missionIdentifier,
    segmentCount: document.segments.length,
    eventCount: flattened.length,
    lastRecordedAtIso: lastEvent?.event.recordedAtIso ?? null,
    isCorrupted: false,
    reason: null,
  };
}
