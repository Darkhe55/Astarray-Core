/**
 * `history`：本地运行历史的**只读** CLI 入口（HISTORY-01-03，2026-10-18）。
 *
 * 只读纪律（卡内 §1/§3）：不恢复 mission、不调模型、不注入上下文、**不重放工具**、
 * 不写任何文件。查询与展示分离：`list` 只看摘要，`show` 按游标取一页时间线。
 *
 * 显示开关（卡内 §4）只影响**视图**：`--hide-tool-calls` / `--hide-run-history` 之后
 * 事件仍保存在本地，`storedEventCount` 与 `hiddenEventCount` 会如实报告。
 */
import {
  DEFAULT_RUN_HISTORY_PAGE_SIZE,
  RUN_HISTORY_EVENT_KINDS,
  listRunHistoryMissions,
  queryRunHistoryTimeline,
  type RunHistoryDisplaySettings,
  type RunHistoryEventKind,
} from "../../../core/src/public-sdk.js";
import { EXIT_CODES, logToStderr, printJson } from "./json-output.js";

/** `history list` 输入。 */
export interface HistoryListCommandInput {
  readonly stateDirectory: string;
  readonly pageSize?: number;
  readonly pageIndex?: number;
  readonly afterMissionIdentifier?: string;
  readonly isJsonOutput: boolean;
}

/** `history show` 输入。 */
export interface HistoryShowCommandInput {
  readonly stateDirectory: string;
  readonly missionIdentifier: string;
  readonly pageSize?: number;
  readonly cursor?: number;
  /** 种类过滤（原样来自 argv，由本命令校验；未知种类 ⇒ 用法错误）。 */
  readonly includedKinds?: ReadonlyArray<string>;
  readonly displaySettings?: Partial<RunHistoryDisplaySettings>;
  readonly isJsonOutput: boolean;
}

/** argv 的种类过滤 ⇒ 已校验的种类列表；出现未知种类时 `hasUnknownKind=true`（调用方报用法错误）。 */
export function resolveIncludedKinds(
  rawKinds: ReadonlyArray<string> | undefined,
): {
  readonly kinds: ReadonlyArray<RunHistoryEventKind> | null;
  readonly unknownKind: string | null;
  readonly hasUnknownKind: boolean;
} {
  if (rawKinds === undefined || rawKinds.length === 0) {
    return { kinds: null, unknownKind: null, hasUnknownKind: false };
  }
  const kinds: RunHistoryEventKind[] = [];
  for (const rawKind of rawKinds) {
    const matched = RUN_HISTORY_EVENT_KINDS.find((kind) => kind === rawKind);
    if (matched === undefined) {
      return { kinds: null, unknownKind: rawKind, hasUnknownKind: true };
    }
    kinds.push(matched);
  }
  return { kinds, unknownKind: null, hasUnknownKind: false };
}

/** 执行 `history list`。返回进程退出码。 */
export async function executeHistoryListCommand(
  input: HistoryListCommandInput,
): Promise<number> {
  let page;
  try {
    page = await listRunHistoryMissions({
      baseDirectory: input.stateDirectory,
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
      ...(input.pageIndex === undefined ? {} : { pageIndex: input.pageIndex }),
      ...(input.afterMissionIdentifier === undefined
        ? {}
        : { afterMissionIdentifier: input.afterMissionIdentifier }),
    });
  } catch (error) {
    logToStderr(
      `读取运行历史列表失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_CODES.FAILURE;
  }

  if (input.isJsonOutput) {
    printJson(page);
    return EXIT_CODES.SUCCESS;
  }

  if (page.entries.length === 0) {
    process.stdout.write("本地没有运行历史（尚未产生工具调用/恢复事件）。\n");
    return EXIT_CODES.SUCCESS;
  }

  const lines: string[] = [];
  lines.push(
    `运行历史：共 ${page.totalMissionCount} 个 mission（第 ${page.pageIndex + 1} 页，每页 ${page.effectivePageSize} 条）`,
  );
  for (const entry of page.entries) {
    if (entry.isCorrupted) {
      lines.push(`- ${entry.missionIdentifier}（记录损坏，需人工注意）：${entry.reason ?? "原因未知"}`);
      continue;
    }
    lines.push(
      `- ${entry.missionIdentifier}：${entry.segmentCount ?? 0} 段 / ${entry.eventCount ?? 0} 条事件，最后 ${entry.lastRecordedAtIso ?? "（无时间）"}`,
    );
  }
  if (page.hasMorePages) {
    const lastEntry = page.entries[page.entries.length - 1];
    lines.push("");
    lines.push(`下一页：--after ${lastEntry?.missionIdentifier ?? ""}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_CODES.SUCCESS;
}

/** 执行 `history show`。返回进程退出码。 */
export async function executeHistoryShowCommand(
  input: HistoryShowCommandInput,
): Promise<number> {
  const resolvedKinds = resolveIncludedKinds(input.includedKinds);
  if (resolvedKinds.hasUnknownKind) {
    logToStderr(
      `未知的事件种类：${resolvedKinds.unknownKind ?? ""}；可用：${RUN_HISTORY_EVENT_KINDS.join("/")}`,
    );
    return EXIT_CODES.USAGE_ERROR;
  }

  let outcome;
  try {
    outcome = await queryRunHistoryTimeline({
      baseDirectory: input.stateDirectory,
      missionIdentifier: input.missionIdentifier,
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(resolvedKinds.kinds === null ? {} : { includedKinds: resolvedKinds.kinds }),
      ...(input.displaySettings === undefined
        ? {}
        : { displaySettings: input.displaySettings }),
    });
  } catch (error) {
    logToStderr(
      `读取运行历史失败：${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_CODES.FAILURE;
  }

  if (outcome.kind === "absent") {
    // 如实失败：没有历史不得伪造成"跑过但没事件"
    logToStderr(`未找到该 mission 的运行历史：${outcome.reason}`);
    return EXIT_CODES.FAILURE;
  }
  if (outcome.kind === "invalid") {
    logToStderr(`运行历史不可用（按损坏处理，不伪造完整）：${outcome.reason}`);
    return EXIT_CODES.FAILURE;
  }

  const page = outcome.page;
  if (input.isJsonOutput) {
    printJson(page);
    return EXIT_CODES.SUCCESS;
  }

  const lines: string[] = [];
  lines.push(
    `运行历史：${page.missionIdentifier}（${page.segmentCount} 段 / 存储 ${page.storedEventCount} 条事件，本页显示 ${page.entries.length} 条）`,
  );
  if (page.notice !== null) lines.push(`提示：${page.notice}`);
  for (const entry of page.entries) {
    lines.push(
      `#${entry.sequenceNumber} [${entry.kindLabel}] ${entry.recordedAtIso}（第 ${entry.segmentRevision} 段）`,
    );
    for (const detailLine of entry.detailText.split("\n")) {
      lines.push(`    ${detailLine}`);
    }
    if (entry.isPayloadUnreadable) lines.push("    （该条详情不是合法 JSON，按原文展示）");
    if (entry.isDetailTruncated) lines.push("    （详情过长，已截断；完整内容仍在本地文件中）");
  }
  if (page.nextCursor !== null) {
    lines.push("");
    lines.push(`下一页：--cursor ${page.nextCursor}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT_CODES.SUCCESS;
}

/** 默认页大小（供 CLI 帮助文本使用，避免两处写死）。 */
export const DEFAULT_HISTORY_PAGE_SIZE = DEFAULT_RUN_HISTORY_PAGE_SIZE;
