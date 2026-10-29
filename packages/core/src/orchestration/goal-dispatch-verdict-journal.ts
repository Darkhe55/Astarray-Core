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
  private readonly maximumRecords: number;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string; maximumRecords?: number }) {
    const directoryPath = path.join(options.baseDirectory, "goal-mode");
    this.filePath = path.join(directoryPath, "dispatch-verdicts.json");
    this.backupFilePath = `${this.filePath}.bak`;
    this.maximumRecords = Math.max(
      1,
      options.maximumRecords ?? DEFAULT_MAXIMUM_GOAL_DISPATCH_VERDICT_RECORDS,
    );
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
  ): Promise<{ readonly droppedRecordCount: number }> {
    return await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const nextRecords = [...document.records, entry];
      const droppedThisTime = Math.max(0, nextRecords.length - this.maximumRecords);
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        totalRecordedCount: document.totalRecordedCount + 1,
        droppedRecordCount: document.droppedRecordCount + droppedThisTime,
        records: nextRecords.slice(-this.maximumRecords),
      } satisfies GoalDispatchVerdictJournalDocument);
      return { droppedRecordCount: droppedThisTime };
    });
  }

  async readRecent(limit: number): Promise<readonly GoalDispatchVerdictEntry[]> {
    const document = await this.read();
    const normalizedLimit = Math.max(0, Math.trunc(limit));
    return document.records.slice(-normalizedLimit);
  }
}
