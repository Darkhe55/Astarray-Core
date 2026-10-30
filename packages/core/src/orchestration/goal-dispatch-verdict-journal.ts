/**
 * R35 (2026-10-29): persistent journal of goal dispatch verdicts.
 *
 * Why: observeGoalDispatchGate only handed each verdict to onGoalDispatchVerdict; when the
 * host did not subscribe, nothing was kept and "why was this dispatch allowed or blocked"
 * became unanswerable after the fact.
 *
 * Rules (mirroring prompt-scan-journal):
 * - bounded (200 records by default); the oldest are dropped and counted in droppedRecordCount;
 * - only verdict fields are stored: mission, project, contract revision, allowed, reason code,
 *   evidence gaps, whether enforcement actually blocked, and the observation time;
 * - no body text is stored;
 * - atomic write with backup recovery; a corrupt file reads back as empty rather than fabricated.
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export interface GoalDispatchVerdictEntry {
  readonly missionIdentifier: string;
  readonly projectIdentifier: string;
  readonly contractRevision: number;
  readonly isAllowed: boolean;
  readonly reasonCode: string | null;
  readonly detail: string | null;
  readonly evidenceGaps: readonly string[];
  readonly isEnforced: boolean;
  readonly observedAtIso: string;
}

export interface GoalDispatchVerdictJournalDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly totalRecordedCount: number;
  readonly droppedRecordCount: number;
  readonly records: readonly GoalDispatchVerdictEntry[];
}

export const DEFAULT_MAXIMUM_GOAL_DISPATCH_VERDICT_RECORDS = 200;

export class GoalDispatchVerdictJournal {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  /**
   * R63（2026-10-30）：**溢出归档**（JSONL，追加写）。
   *
   * 此前超出上限的记录**直接丢弃**（只剩 `droppedRecordCount`）。现在把它们先追加到
   * `dispatch-verdicts-archive.jsonl` 再从活动文件移除 —— 活动视图仍有界，历史不再凭空消失。
   * 归档**本身无上限/无压缩**（增长由外部治理）。
   */
  private readonly archiveFilePath: string;
  private readonly directoryPath: string;
  private readonly maximumRecords: number;
  /**
   * R65（2026-10-30）：**归档治理**（容量上限 + 轮转 + 保留份数）。
   *
   * - 当前归档超过 `maximumArchiveLines` ⇒ 轮转为 `dispatch-verdicts-archive-<UTC14>-<n>.jsonl`；
   * - 轮转文件只保留最近 `archiveRetentionCount` 份，更旧的**删除**（这是真正的删除，
   *   调用方需知道：保留窗口外的历史仍会消失，只是比"200 条即丢"宽得多）。
   */
  private readonly maximumArchiveLines: number;
  private readonly archiveRetentionCount: number;
  private readonly writeLock = new AsyncMutex();

  constructor(options: {
    baseDirectory: string;
    maximumRecords?: number;
    maximumArchiveLines?: number;
    archiveRetentionCount?: number;
  }) {
    this.directoryPath = path.join(options.baseDirectory, "goal-mode");
    this.filePath = path.join(this.directoryPath, "dispatch-verdicts.json");
    this.backupFilePath = `${this.filePath}.bak`;
    this.archiveFilePath = path.join(this.directoryPath, "dispatch-verdicts-archive.jsonl");
    this.maximumRecords = Math.max(
      1,
      options.maximumRecords ?? DEFAULT_MAXIMUM_GOAL_DISPATCH_VERDICT_RECORDS,
    );
    this.maximumArchiveLines = Math.max(1, options.maximumArchiveLines ?? 5000);
    this.archiveRetentionCount = Math.max(1, options.archiveRetentionCount ?? 2);
  }

  /** 轮转文件名前缀（用于识别、排序与清理；基名 `dispatch-verdicts-archive.jsonl` 不匹配）。 */
  private static readonly ROTATED_ARCHIVE_PATTERN =
    /^dispatch-verdicts-archive-\d{14}-\d+\.jsonl$/;

  /** 读取当前归档行数（不存在 ⇒ 0）。 */
  private async countArchiveLines(): Promise<number> {
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(this.archiveFilePath, "utf8");
      return content.split(/\r?\n/).filter((line) => line !== "").length;
    } catch {
      return 0;
    }
  }

  /**
   * 归档前检查容量：超限则**先轮转再裁剪旧轮转**（保留最近 N 份）。
   *
   * 返回是否发生了轮转；任何一步失败都不阻断写入（最坏是归档变大）。
   */
  private async rotateArchiveIfNeeded(incomingLineCount: number): Promise<boolean> {
    const currentLineCount = await this.countArchiveLines();
    if (currentLineCount === 0) {
      return false;
    }
    if (currentLineCount + incomingLineCount <= this.maximumArchiveLines) {
      return false;
    }
    try {
      const { readdir, rename, unlink } = await import("node:fs/promises");
      const runTag = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
      let rotatedName = "";
      for (let attempt = 1; attempt <= 100; attempt += 1) {
        const candidate = `dispatch-verdicts-archive-${runTag}-${String(attempt)}.jsonl`;
        const candidatePath = path.join(this.directoryPath, candidate);
        const exists = await readdir(this.directoryPath)
          .then((names) => names.includes(candidate))
          .catch(() => false);
        if (!exists) {
          rotatedName = candidate;
          await rename(this.archiveFilePath, candidatePath);
          break;
        }
      }
      if (rotatedName === "") {
        return false;
      }
      /** 清理：只保留最近 N 份轮转文件（按名称排序 = 按时间排序）。 */
      const rotatedFiles = (await readdir(this.directoryPath))
        .filter((name) => GoalDispatchVerdictJournal.ROTATED_ARCHIVE_PATTERN.test(name))
        .sort();
      const excessCount = rotatedFiles.length - this.archiveRetentionCount;
      for (const name of rotatedFiles.slice(0, Math.max(0, excessCount))) {
        await unlink(path.join(this.directoryPath, name)).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<GoalDispatchVerdictJournalDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return {
        schemaVersion: 1,
        documentRevision: 0,
        totalRecordedCount: 0,
        droppedRecordCount: 0,
        records: [],
      };
    }
    const content = readResult.content as Partial<GoalDispatchVerdictJournalDocument> | null;
    if (content === null || typeof content !== "object" || !Array.isArray(content.records)) {
      return {
        schemaVersion: 1,
        documentRevision: 0,
        totalRecordedCount: 0,
        droppedRecordCount: 0,
        records: [],
      };
    }
    return {
      schemaVersion: 1,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      totalRecordedCount:
        typeof content.totalRecordedCount === "number" ? content.totalRecordedCount : 0,
      droppedRecordCount:
        typeof content.droppedRecordCount === "number" ? content.droppedRecordCount : 0,
      records: content.records,
    };
  }

  async record(
    entry: GoalDispatchVerdictEntry,
  ): Promise<{ readonly droppedRecordCount: number; readonly archivedRecordCount: number }> {
    return await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const nextRecords = [...document.records, entry];
      const overflowCount = Math.max(0, nextRecords.length - this.maximumRecords);
      const overflowRecords =
        overflowCount === 0 ? [] : nextRecords.slice(0, overflowCount);
      /**
       * R63：**先归档、再裁剪**；归档失败则**不裁剪**（宁可活动文件超限，也不让记录消失）。
       */
      let archivedRecordCount = 0;
      if (overflowRecords.length > 0) {
        try {
          /** R65：先按容量决定是否轮转（失败不阻断写入）。 */
          await this.rotateArchiveIfNeeded(overflowRecords.length);
          const { appendFile } = await import("node:fs/promises");
          const jsonLines = overflowRecords
            .map((record) => JSON.stringify(record))
            .join("\n");
          await appendFile(this.archiveFilePath, `${jsonLines}\n`, "utf8");
          archivedRecordCount = overflowRecords.length;
        } catch {
          archivedRecordCount = 0;
        }
      }
      const remainingRecords =
        overflowRecords.length > 0 && archivedRecordCount === overflowRecords.length
          ? nextRecords.slice(-this.maximumRecords)
          : nextRecords;
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        totalRecordedCount: document.totalRecordedCount + 1,
        /** 只有**真正被丢弃**的才计数；已归档的不再算丢弃。 */
        droppedRecordCount:
          document.droppedRecordCount +
          (overflowRecords.length > 0 && archivedRecordCount === overflowRecords.length
            ? 0
            : overflowRecords.length),
        records: remainingRecords,
      } satisfies GoalDispatchVerdictJournalDocument);
      return {
        droppedRecordCount:
          overflowRecords.length > 0 && archivedRecordCount === overflowRecords.length
            ? 0
            : overflowRecords.length,
        archivedRecordCount,
      };
    });
  }

  async readRecent(limit: number): Promise<readonly GoalDispatchVerdictEntry[]> {
    const document = await this.read();
    const normalizedLimit = Math.max(0, Math.trunc(limit));
    return document.records.slice(-normalizedLimit);
  }
}
