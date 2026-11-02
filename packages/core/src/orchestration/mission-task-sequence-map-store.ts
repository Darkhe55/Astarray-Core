/**
 * R123（2026-11-01）：**mission 任务 ↔ 权威序列节点 的持久映射**。
 *
 * 背景：两套记账的 id 不同（mission `T-01` vs 序列 `task-mission-…` / 自定义 id），
 * 仅靠形态推断在多节点序列上会误报（ADR-0181 §5）。本存储显式记录映射，
 * 由 `task-ledger bind-task-map` 写入、写回提案读取。
 *
 * 纪律：
 * - 一个 mission 任务只能映射到一个序列节点；同 mission+task 重复绑定到**不同**节点 ⇒ 拒绝（不静默改绑）；
 * - 重复绑定同一对 ⇒ 幂等；
 * - 原子写 + 备份恢复；损坏读回空文档（宁可"未知"也不伪造）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";

export interface MissionTaskSequenceMapEntry {
  readonly missionIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly ownerAgentInstanceIdentifier: string;
  readonly missionTaskIdentifier: string;
  readonly sequenceTaskIdentifier: string;
  readonly mappedAtIso: string;
}

export interface MissionTaskSequenceMapDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly maps: readonly MissionTaskSequenceMapEntry[];
}

export class MissionTaskSequenceMapStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directoryPath = path.join(options.baseDirectory, "task-ledger");
    this.filePath = path.join(directoryPath, "mission-task-maps.json");
    this.backupFilePath = `${this.filePath}.bak`;
  }

  async read(): Promise<MissionTaskSequenceMapDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, documentRevision: 0, maps: [] };
    }
    const content = readResult.content as Partial<MissionTaskSequenceMapDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      !Array.isArray(content.maps)
    ) {
      return { schemaVersion: 1, documentRevision: 0, maps: [] };
    }
    return {
      schemaVersion: 1,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      maps: content.maps.filter(
        (entry): entry is MissionTaskSequenceMapEntry =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.missionIdentifier === "string" &&
          typeof entry.sequenceIdentifier === "string" &&
          typeof entry.ownerAgentInstanceIdentifier === "string" &&
          typeof entry.missionTaskIdentifier === "string" &&
          typeof entry.sequenceTaskIdentifier === "string" &&
          typeof entry.mappedAtIso === "string",
      ),
    };
  }

  /**
   * R139（2026-11-03）：**删除任务时清理其映射**（避免映射指向已消失的节点）。
   *
   * 只删匹配 mission + missionTaskIdentifier 的条目；`"*"`（整 mission）不动。
   */
  async removeForMissionTask(input: {
    readonly missionIdentifier: string;
    readonly missionTaskIdentifier: string;
  }): Promise<{ readonly removedCount: number }> {
    return this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const kept = document.maps.filter(
        (entry) =>
          !(
            entry.missionIdentifier === input.missionIdentifier &&
            entry.missionTaskIdentifier === input.missionTaskIdentifier
          ),
      );
      const removedCount = document.maps.length - kept.length;
      if (removedCount === 0) {
        return { removedCount };
      }
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        maps: kept,
      } satisfies MissionTaskSequenceMapDocument);
      return { removedCount };
    });
  }
  /** 按 mission+sequence 列出映射（写回提案使用）。 */
  async listForMission(input: {
    readonly missionIdentifier: string;
    readonly sequenceIdentifier: string;
  }): Promise<readonly MissionTaskSequenceMapEntry[]> {
    const document = await this.read();
    return document.maps.filter(
      (entry) =>
        entry.missionIdentifier === input.missionIdentifier &&
        entry.sequenceIdentifier === input.sequenceIdentifier,
    );
  }

  async bind(input: {
    readonly missionIdentifier: string;
    readonly sequenceIdentifier: string;
    readonly ownerAgentInstanceIdentifier: string;
    readonly missionTaskIdentifier: string;
    readonly sequenceTaskIdentifier: string;
    readonly mappedAtIso?: string;
  }): Promise<{ readonly didWrite: boolean }> {
    return this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const existing = document.maps.find(
        (entry) =>
          entry.missionIdentifier === input.missionIdentifier &&
          entry.missionTaskIdentifier === input.missionTaskIdentifier,
      );
      if (existing !== undefined) {
        if (existing.sequenceTaskIdentifier === input.sequenceTaskIdentifier) {
          return { didWrite: false };
        }
        throw new DomainError(
          "journal-corrupted",
          `mission ${input.missionIdentifier} 的任务 ${input.missionTaskIdentifier} 已映射到 ${existing.sequenceTaskIdentifier}，拒绝改绑到 ${input.sequenceTaskIdentifier}。`,
        );
      }
      const entry: MissionTaskSequenceMapEntry = {
        missionIdentifier: input.missionIdentifier,
        sequenceIdentifier: input.sequenceIdentifier,
        ownerAgentInstanceIdentifier: input.ownerAgentInstanceIdentifier,
        missionTaskIdentifier: input.missionTaskIdentifier,
        sequenceTaskIdentifier: input.sequenceTaskIdentifier,
        mappedAtIso: input.mappedAtIso ?? new Date().toISOString(),
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        maps: [...document.maps, entry],
      } satisfies MissionTaskSequenceMapDocument);
      return { didWrite: true };
    });
  }
}
