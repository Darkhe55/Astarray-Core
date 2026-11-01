/**
 * R125（2026-11-01）：**提示词扫描记录的持久化**（有界 + 丢弃计数）。
 *
 * 背景：ADR-0104 的扫描记录只在进程内环形缓冲，进程退出即丢，事后无法回答
 * "某次注入前上下文是否检查过"。本存储把记录落盘，纪律与判定记录一致：
 *
 * - **只记录结论**（不记录提示词正文，避免诊断变成第二次泄漏）；
 * - 有界（默认 100 条），挤出的最旧记录计入 `droppedRecordCount`（不静默消失）；
 * - 原子写 + 备份恢复；损坏读回空文档（宁可"未知"也不伪造）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export interface PersistedPromptScanRecord {
  readonly missionIdentifier: string;
  readonly agentInstanceIdentifier: string;
  readonly taskIdentifier: string;
  readonly outcome: string;
  readonly ruleSetVersion: number;
  readonly matchedRuleIdentifiers: readonly string[];
  readonly limitReason: string | null;
  readonly isClean: boolean;
  readonly recordedAtIso: string;
}

export interface PromptScanJournalDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly maximumRecords: number;
  readonly droppedRecordCount: number;
  readonly records: readonly PersistedPromptScanRecord[];
}

export const PROMPT_SCAN_JOURNAL_MAXIMUM_RECORDS = 100;

export class PromptScanJournalStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directoryPath = path.join(options.baseDirectory);
    this.filePath = path.join(directoryPath, "prompt-scan-journal.json");
    this.backupFilePath = `${this.filePath}.bak`;
  }

  async read(): Promise<PromptScanJournalDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return {
        schemaVersion: 1,
        documentRevision: 0,
        maximumRecords: PROMPT_SCAN_JOURNAL_MAXIMUM_RECORDS,
        droppedRecordCount: 0,
        records: [],
      };
    }
    const content = readResult.content as Partial<PromptScanJournalDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      !Array.isArray(content.records)
    ) {
      return {
        schemaVersion: 1,
        documentRevision: 0,
        maximumRecords: PROMPT_SCAN_JOURNAL_MAXIMUM_RECORDS,
        droppedRecordCount: 0,
        records: [],
      };
    }
    const maximumRecords =
      typeof content.maximumRecords === "number" && content.maximumRecords > 0
        ? content.maximumRecords
        : PROMPT_SCAN_JOURNAL_MAXIMUM_RECORDS;
    return {
      schemaVersion: 1,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      maximumRecords,
      droppedRecordCount:
        typeof content.droppedRecordCount === "number"
          ? content.droppedRecordCount
          : 0,
      records: content.records.filter(
        (record): record is PersistedPromptScanRecord =>
          record !== null &&
          typeof record === "object" &&
          typeof record.missionIdentifier === "string" &&
          typeof record.recordedAtIso === "string",
      ),
    };
  }

  /** 追加一条；超过上限时挤出最旧并累计丢弃计数。 */
  async append(record: PersistedPromptScanRecord): Promise<void> {
    await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const combined = [...document.records, record];
      const overflow = Math.max(0, combined.length - document.maximumRecords);
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        maximumRecords: document.maximumRecords,
        droppedRecordCount: document.droppedRecordCount + overflow,
        records: combined.slice(overflow),
      } satisfies PromptScanJournalDocument);
    });
  }
}
