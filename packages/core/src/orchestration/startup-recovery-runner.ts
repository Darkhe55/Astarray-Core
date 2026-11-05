/**
 * 启动自动恢复：Phase 2（2026-11-05）——按动态上限/并发/失败上限执行。
 *
 * 只处理 `kind=mission-resume` 的候选（sequence-only 需要"派发成新 mission"，
 * 不在本阶段实现；报告里如实标 `sequence-only-not-dispatched`）。
 *
 * 所有副作用都走注入端口：
 * - `resumeMission` 由运行时接到核心恢复（其内部已有对账/目标/租约/就绪门禁）；
 * - 失败计数落 `StartupRecoveryAttemptStore`，达到上限后不再自动恢复；
 * - 批间冷却使用注入的 `sleep`，测试不必真等。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { cleanStaleTempFiles, readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import type { StartupRecoveryPolicy } from "./startup-recovery-policy.js";
import type {
  StartupRecoveryPlan,
  StartupRecoverySelectedEntry,
} from "./startup-recovery-scanner.js";

export interface StartupRecoveryAttemptRecord {
  readonly missionIdentifier: string;
  readonly attemptCount: number;
  readonly lastAttemptAtIso: string;
  readonly lastOutcome: "resumed" | "failed";
  readonly lastReason: string | null;
}

interface AttemptsDocument {
  readonly schemaVersion: 1;
  readonly attempts: Record<string, StartupRecoveryAttemptRecord>;
}

export class StartupRecoveryAttemptStore {
  private readonly directoryPath: string;
  private readonly filePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "startup-recovery");
    this.filePath = path.join(this.directoryPath, "attempts.json");
  }

  private async readDocument(): Promise<AttemptsDocument> {
    const result = await readJsonWithBackupRecovery(
      this.filePath,
      `${this.filePath}.bak`,
    ).catch(() => null);
    if (result === null) {
      return { schemaVersion: 1, attempts: {} };
    }
    const content = result.content as Partial<AttemptsDocument> | null;
    return {
      schemaVersion: 1,
      attempts: content?.attempts ?? {},
    };
  }

  async readAttempt(missionIdentifier: string): Promise<StartupRecoveryAttemptRecord | null> {
    const document = await this.readDocument();
    return document.attempts[missionIdentifier] ?? null;
  }

  async recordAttempt(input: {
    readonly missionIdentifier: string;
    readonly outcome: "resumed" | "failed";
    readonly reason: string | null;
    readonly attemptedAtIso: string;
  }): Promise<StartupRecoveryAttemptRecord> {
    return this.writeLock.runExclusive(async () => {
      const document = await this.readDocument();
      const previous = document.attempts[input.missionIdentifier];
      const attemptCount = input.outcome === "failed" ? (previous?.attemptCount ?? 0) + 1 : 0;
      const record: StartupRecoveryAttemptRecord = {
        missionIdentifier: input.missionIdentifier,
        attemptCount,
        lastAttemptAtIso: input.attemptedAtIso,
        lastOutcome: input.outcome,
        lastReason: input.reason,
      };
      const next: AttemptsDocument = {
        schemaVersion: 1,
        attempts: { ...document.attempts, [input.missionIdentifier]: record },
      };
      await fs.mkdir(this.directoryPath, { recursive: true });
      await cleanStaleTempFiles(this.directoryPath, "attempts.json");
      await writeAtomicJson(this.filePath, next);
      return record;
    });
  }

  async resetAttempt(missionIdentifier: string): Promise<boolean> {
    return this.writeLock.runExclusive(async () => {
      const document = await this.readDocument();
      if (!(missionIdentifier in document.attempts)) return false;
      const attempts = { ...document.attempts };
      delete attempts[missionIdentifier];
      await fs.mkdir(this.directoryPath, { recursive: true });
      await cleanStaleTempFiles(this.directoryPath, "attempts.json");
      await writeAtomicJson(this.filePath, { schemaVersion: 1, attempts });
      return true;
    });
  }
}

export interface StartupRecoveryRunPorts {
  readonly resumeMission: (missionIdentifier: string) => Promise<void>;
  readonly readAttemptCount: (missionIdentifier: string) => Promise<number>;
  readonly recordAttempt: (input: {
    readonly missionIdentifier: string;
    readonly outcome: "resumed" | "failed";
    readonly reason: string | null;
    readonly attemptedAtIso: string;
  }) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly nowIso: () => string;
}

export interface StartupRecoveryRunReport {
  readonly resumed: readonly string[];
  readonly failed: readonly {
    readonly missionIdentifier: string;
    readonly reason: string;
  }[];
  readonly skipped: readonly {
    readonly missionIdentifier: string | null;
    readonly taskIdentifier: string;
    readonly reason: string;
  }[];
  readonly batchCount: number;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
}

function describeError(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runStartupRecoveryPlan(input: {
  readonly plan: StartupRecoveryPlan;
  readonly policy: StartupRecoveryPolicy;
  readonly ports: StartupRecoveryRunPorts;
}): Promise<StartupRecoveryRunReport> {
  const startedAtIso = input.ports.nowIso();
  const resumed: string[] = [];
  const failed: { missionIdentifier: string; reason: string }[] = [];
  const skipped: { missionIdentifier: string | null; taskIdentifier: string; reason: string }[] = [];

  const resumableMissions: StartupRecoverySelectedEntry[] = [];
  for (const entry of input.plan.selected) {
    if (entry.kind !== "mission-resume") {
      skipped.push({
        missionIdentifier: entry.missionIdentifier,
        taskIdentifier: entry.taskIdentifier,
        reason: "sequence-only-not-dispatched（序列任务需派发成 mission，Phase 3 未实现）",
      });
      continue;
    }
    const attemptCount = await input.ports.readAttemptCount(
      String(entry.missionIdentifier),
    );
    if (attemptCount >= input.policy.maximumAttemptsPerTask) {
      skipped.push({
        missionIdentifier: entry.missionIdentifier,
        taskIdentifier: entry.taskIdentifier,
        reason: `连续失败 ${String(attemptCount)} 次，已达上限 ${String(input.policy.maximumAttemptsPerTask)}`,
      });
      continue;
    }
    resumableMissions.push(entry);
  }

  const batchSize = Math.max(1, input.policy.maximumConcurrentResumes);
  let batchCount = 0;
  for (let offset = 0; offset < resumableMissions.length; offset += batchSize) {
    const batch = resumableMissions.slice(offset, offset + batchSize);
    batchCount += 1;
    await Promise.all(
      batch.map(async (entry) => {
        const missionIdentifier = String(entry.missionIdentifier);
        try {
          await input.ports.resumeMission(missionIdentifier);
          resumed.push(missionIdentifier);
          await input.ports.recordAttempt({
            missionIdentifier,
            outcome: "resumed",
            reason: null,
            attemptedAtIso: input.ports.nowIso(),
          });
        } catch (error) {
          const reason = describeError(error);
          failed.push({ missionIdentifier, reason });
          await input.ports.recordAttempt({
            missionIdentifier,
            outcome: "failed",
            reason,
            attemptedAtIso: input.ports.nowIso(),
          });
        }
      }),
    );
    const hasMoreBatches = offset + batchSize < resumableMissions.length;
    if (hasMoreBatches && input.policy.cooldownMilliseconds > 0) {
      await input.ports.sleep(input.policy.cooldownMilliseconds);
    }
  }

  return {
    resumed,
    failed,
    skipped,
    batchCount,
    startedAtIso,
    finishedAtIso: input.ports.nowIso(),
  };
}
