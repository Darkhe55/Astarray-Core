/**
 * GUI-04-06 / ALIGN-04-04（2026-11-03）：**因工作时段休息被挡的 mission 记账与一次性恢复**。
 *
 * 背景：`evaluateWorkWindowResume` 与 `MainController.handleWorkWindowResume` 已实现，
 * 但此前**没有调用方**：时段门禁拒绝后 mission 直接失败，rest→working 也没有恢复闭环。
 *
 * 纪律：
 * - 只在门禁拒绝时登记；同一 mission 去重（保留最近一次原因/时间）；
 * - 恢复只对"因休息被挡"的 mission 生效，且**成功后即移除**（同一轮不重复执行）；
 * - 恢复被核心拒绝（坏检查点/未决冲突等）⇒ 保留记录，不假装成功；
 * - 人工暂停不登记（人工暂停优先，不因时段变化复活）。
 */
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { AsyncMutex } from "../infra/async-mutex.js";

export const WORK_WINDOW_DEFERRED_SCHEMA_VERSION = 1;

export interface WorkWindowDeferredMissionRecord {
  readonly missionIdentifier: string;
  readonly projectIdentifier: string | null;
  readonly reason: string;
  readonly deferredAtIso: string;
  readonly lastObservedAtIso: string;
}

interface DeferredDocument {
  readonly schemaVersion: 1;
  readonly records: readonly WorkWindowDeferredMissionRecord[];
}

export class WorkWindowDeferredMissionStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(
    private readonly options: {
      baseDirectory: string;
      nowIso?: () => string;
    },
  ) {
    const directory = path.join(options.baseDirectory, "work-window");
    this.filePath = path.join(directory, "deferred-missions.json");
    this.backupFilePath = `${this.filePath}.bak`;
  }

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  private async readDocument(): Promise<DeferredDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    ).catch(() => null);
    if (readResult === null) {
      return { schemaVersion: 1, records: [] };
    }
    const content = readResult.content as Partial<DeferredDocument> | null;
    if (content === null || typeof content !== "object" || !Array.isArray(content.records)) {
      return { schemaVersion: 1, records: [] };
    }
    const records = content.records.filter(
      (record): record is WorkWindowDeferredMissionRecord =>
        record !== null &&
        typeof record === "object" &&
        typeof record.missionIdentifier === "string" &&
        typeof record.reason === "string" &&
        typeof record.deferredAtIso === "string" &&
        typeof record.lastObservedAtIso === "string",
    );
    return { schemaVersion: 1, records };
  }

  async list(): Promise<WorkWindowDeferredMissionRecord[]> {
    return [...(await this.readDocument()).records];
  }

  /** 登记/更新（同一 mission 去重；不因重复观察产生多条）。 */
  async record(input: {
    missionIdentifier: string;
    projectIdentifier: string | null;
    reason: string;
  }): Promise<void> {
    if (input.missionIdentifier.trim() === "") {
      return;
    }
    await this.writeLock.runExclusive(async () => {
      const document = await this.readDocument();
      const nowIso = this.nowIso();
      const existing = document.records.find(
        (record) => record.missionIdentifier === input.missionIdentifier,
      );
      const record: WorkWindowDeferredMissionRecord = {
        missionIdentifier: input.missionIdentifier,
        projectIdentifier: input.projectIdentifier,
        reason: input.reason,
        deferredAtIso: existing?.deferredAtIso ?? nowIso,
        lastObservedAtIso: nowIso,
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        records: [
          ...document.records.filter(
            (entry) => entry.missionIdentifier !== input.missionIdentifier,
          ),
          record,
        ],
      } satisfies DeferredDocument);
    });
  }

  async remove(missionIdentifier: string): Promise<void> {
    await this.writeLock.runExclusive(async () => {
      const document = await this.readDocument();
      const remaining = document.records.filter(
        (record) => record.missionIdentifier !== missionIdentifier,
      );
      if (remaining.length === document.records.length) {
        return;
      }
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        records: remaining,
      } satisfies DeferredDocument);
    });
  }
}

export interface WorkWindowDeferredResumeOutcome {
  readonly missionIdentifier: string;
  readonly didResume: boolean;
  readonly decision: string;
  readonly reason: string;
}

/**
 * 一次性恢复：按登记顺序逐条尝试；成功/已在运行 ⇒ 移除；被拒 ⇒ 保留（下一轮再试）。
 * 不并发恢复，避免同一任务被两个调度器同时拉起。
 */
export async function resumeDeferredWorkWindowMissions(input: {
  readonly store: WorkWindowDeferredMissionStore;
  readonly resume: (missionIdentifier: string) => Promise<{
    readonly didResume: boolean;
    readonly decision: string;
    readonly reason: string;
  }>;
}): Promise<WorkWindowDeferredResumeOutcome[]> {
  const records = await input.store.list();
  const outcomes: WorkWindowDeferredResumeOutcome[] = [];
  for (const record of records) {
    let result: { readonly didResume: boolean; readonly decision: string; readonly reason: string };
    try {
      result = await input.resume(record.missionIdentifier);
    } catch (error) {
      result = {
        didResume: false,
        decision: "resume-error",
        reason: (error as Error).message,
      };
    }
    outcomes.push({
      missionIdentifier: record.missionIdentifier,
      didResume: result.didResume,
      decision: result.decision,
      reason: result.reason,
    });
    if (result.didResume || result.decision === "already-running") {
      await input.store.remove(record.missionIdentifier);
    }
  }
  return outcomes;
}
