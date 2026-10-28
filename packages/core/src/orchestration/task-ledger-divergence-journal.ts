/**
 * 清单第 ① 项收尾（2026-10-28）：**两套记账的差异历史**（只读诊断）。
 *
 * 目的：让"权威序列 vs mission 任务链可能短暂不一致"这件事从"能查一次"变成
 * "**有历史可追溯**"。本模块**只记录**，**不修复**任何一边（不写序列、不改任务链）。
 *
 * 落盘：`<state>/task-ledger-divergence/journal.json`（原子写 + 互斥 + 备份恢复）。
 * 条目有上限（缺省 200 条，先进先出）；**连续相同差异只记一次**（避免同一漂移刷屏）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export const TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION = 1;
export const MAXIMUM_TASK_LEDGER_DIVERGENCE_ENTRIES = 200;

/** 差异快照（从 `TaskLedgerAlignmentReport` 摘取的可追溯字段）。 */
export interface TaskLedgerDivergenceEntry {
  readonly recordedAtIso: string;
  readonly missionIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly sequenceRevision: number;
  readonly sequenceTaskCount: number;
  readonly missionTaskCount: number;
  readonly tasksOnlyInSequence: readonly string[];
  readonly tasksOnlyInMission: readonly string[];
  readonly statusMismatchCount: number;
  /** 差异内容哈希（连续重复即跳过；用于去重，不用于判定"一致"）。 */
  readonly divergenceHash: string;
  /** 触发场景（运行中插入后 / 手动检查 / 恢复后对账）。 */
  readonly trigger: string;
}

export interface TaskLedgerDivergenceJournalDocument {
  readonly schemaVersion: typeof TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION;
  readonly documentRevision: number;
  readonly entries: readonly TaskLedgerDivergenceEntry[];
}

export class TaskLedgerDivergenceJournal {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lock = new AsyncMutex();
  private readonly maximumEntries: number;

  constructor(options: { baseDirectory: string; maximumEntries?: number }) {
    const directory = path.join(options.baseDirectory, "task-ledger-divergence");
    this.filePath = path.join(directory, "journal.json");
    this.backupFilePath = path.join(directory, "journal.json.bak");
    this.maximumEntries =
      options.maximumEntries ?? MAXIMUM_TASK_LEDGER_DIVERGENCE_ENTRIES;
  }

  async read(): Promise<TaskLedgerDivergenceJournalDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return {
        schemaVersion: TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION,
        documentRevision: 0,
        entries: [],
      };
    }
    const content = readResult.content as Partial<TaskLedgerDivergenceJournalDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      !Array.isArray(content.entries)
    ) {
      return {
        schemaVersion: TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION,
        documentRevision: 0,
        entries: [],
      };
    }
    return {
      schemaVersion: TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      entries: content.entries,
    };
  }

  /**
   * 追加一条差异快照。
   *
   * 规则：与**上一条**的 `divergenceHash` 相同 ⇒ 不重复记录（返回 recorded:false）；
   * 条目超过上限 ⇒ 丢弃最旧的。
   */
  async append(
    entry: TaskLedgerDivergenceEntry,
  ): Promise<{ readonly recorded: boolean; readonly reason: string }> {
    return await this.lock.runExclusive(async () => {
      const document = await this.read();
      const lastEntry = document.entries[document.entries.length - 1];
      if (lastEntry !== undefined && lastEntry.divergenceHash === entry.divergenceHash) {
        return {
          recorded: false,
          reason: "与上一条差异相同：不重复记录（避免同一漂移刷屏）。",
        };
      }
      const entries = [...document.entries, entry].slice(-this.maximumEntries);
      await writeAtomicJson(this.filePath, {
        schemaVersion: TASK_LEDGER_DIVERGENCE_JOURNAL_SCHEMA_VERSION,
        documentRevision: document.documentRevision + 1,
        entries,
      } satisfies TaskLedgerDivergenceJournalDocument);
      return { recorded: true, reason: "已记录差异快照。" };
    });
  }

  async readRecent(limit: number): Promise<readonly TaskLedgerDivergenceEntry[]> {
    const document = await this.read();
    if (limit <= 0) {
      return [];
    }
    return document.entries.slice(-limit);
  }
}

/** 由对齐报告构造差异条目（纯函数；`trigger` 由调用方给出）。 */
export function buildTaskLedgerDivergenceEntry(input: {
  readonly report: {
    readonly missionIdentifier: string;
    readonly sequenceId: string;
    readonly sequenceRevision: number;
    readonly sequenceTaskIdentifiers: readonly string[];
    readonly missionTaskIdentifiers: readonly string[];
    readonly tasksOnlyInSequence: readonly string[];
    readonly tasksOnlyInMission: readonly string[];
    readonly statusMismatches: readonly {
      readonly taskIdentifier: string;
      readonly sequenceStatus: string;
      readonly missionStatus: string;
    }[];
  };
  readonly recordedAtIso: string;
  readonly trigger: string;
}): TaskLedgerDivergenceEntry {
  const divergenceHash = JSON.stringify({
    sequenceRevision: input.report.sequenceRevision,
    onlySequence: [...input.report.tasksOnlyInSequence].sort(),
    onlyMission: [...input.report.tasksOnlyInMission].sort(),
    mismatches: input.report.statusMismatches
      .map(
        (mismatch) =>
          `${mismatch.taskIdentifier}:${mismatch.sequenceStatus}->${mismatch.missionStatus}`,
      )
      .sort(),
  });
  return {
    recordedAtIso: input.recordedAtIso,
    missionIdentifier: input.report.missionIdentifier,
    sequenceIdentifier: input.report.sequenceId,
    sequenceRevision: input.report.sequenceRevision,
    sequenceTaskCount: input.report.sequenceTaskIdentifiers.length,
    missionTaskCount: input.report.missionTaskIdentifiers.length,
    tasksOnlyInSequence: [...input.report.tasksOnlyInSequence],
    tasksOnlyInMission: [...input.report.tasksOnlyInMission],
    statusMismatchCount: input.report.statusMismatches.length,
    divergenceHash,
    trigger: input.trigger,
  };
}
