/**
 * ALIGN-04-01（2026-10-28）：**mission 关系索引**（显式关联的权威落盘）。
 *
 * 卡内要求：持久化 project/conversation/agent/sequence/group/mission 的**显式关联**，
 * 不只存在 `MainController` 的 Map；重启从权威记录恢复映射，**不按昵称或路径字符串猜归属**。
 *
 * 本模块只存"当时明确登记过的事实"：
 * - 每条 mission 一个文件：`<state>/mission-relations/<missionId>.json`（+ `.bak`）；
 * - 字段非空即"登记过"，空值表示**当时没有**（不是"没记"）；`revision` 单调递增；
 * - 合并写入只覆盖**显式给出**的字段，不因为一次登记把别的字段清空；
 * - 读取失败/损坏 ⇒ 抛 `journal-corrupted`（不返回空记录冒充"没有关联"）。
 *
 * 不推断：本模块**不**从 missionId/路径/昵称推导任何归属；缺字段就是缺字段。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  cleanStaleTempFiles,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import { decodePathSegment, sanitizePathSegment } from "./work-archive-store.js";

export const MISSION_RELATION_SCHEMA_VERSION = 1;

export interface MissionRelationRecord {
  readonly schemaVersion: typeof MISSION_RELATION_SCHEMA_VERSION;
  readonly missionIdentifier: string;
  readonly revision: number;
  readonly projectIdentifier: string | null;
  readonly conversationIdentifier: string | null;
  readonly mainAgentInstanceIdentifier: string | null;
  /** 权威任务序列（`sequence-<secondary>`）与任务标识。 */
  readonly taskSequenceIdentifier: string | null;
  readonly taskIdentifier: string | null;
  /** 序列 owner（次级个体）；恢复后重新登记序列端口需要它。 */
  readonly sequenceOwnerAgentInstanceIdentifier: string | null;
  /** 任务包（group）标识；未分组时为空数组。 */
  readonly taskBundleIdentifiers: readonly string[];
  /** 参与本 mission 的个体（主/次/三级）；空数组表示未登记。 */
  readonly agentInstanceIdentifiers: readonly string[];
  readonly recordedAtIso: string;
  readonly updatedAtIso: string;
}

export interface MissionRelationUpsertInput {
  readonly missionIdentifier: string;
  readonly projectIdentifier?: string | null;
  readonly conversationIdentifier?: string | null;
  readonly mainAgentInstanceIdentifier?: string | null;
  readonly taskSequenceIdentifier?: string | null;
  readonly taskIdentifier?: string | null;
  readonly sequenceOwnerAgentInstanceIdentifier?: string | null;
  readonly taskBundleIdentifiers?: readonly string[];
  readonly agentInstanceIdentifiers?: readonly string[];
}

export interface MissionRelationIndexStoreOptions {
  readonly baseDirectory: string;
  readonly nowIso?: () => string;
}

export class MissionRelationIndexStore {
  private readonly relationsDirectoryPath: string;
  private readonly lock = new AsyncMutex();
  private readonly nowIso: () => string;

  constructor(options: MissionRelationIndexStoreOptions) {
    this.relationsDirectoryPath = path.join(options.baseDirectory, "mission-relations");
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  private relationFilePath(missionIdentifier: string): string {
    return path.join(
      this.relationsDirectoryPath,
      `${sanitizePathSegment(missionIdentifier)}.json`,
    );
  }

  private backupFilePath(missionIdentifier: string): string {
    return `${this.relationFilePath(missionIdentifier)}.bak`;
  }

  async read(missionIdentifier: string): Promise<MissionRelationRecord | null> {
    const readResult = await readJsonWithBackupRecovery(
      this.relationFilePath(missionIdentifier),
      this.backupFilePath(missionIdentifier),
    );
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as Partial<MissionRelationRecord>;
    if (
      content.schemaVersion !== MISSION_RELATION_SCHEMA_VERSION ||
      typeof content.missionIdentifier !== "string" ||
      content.missionIdentifier !== missionIdentifier ||
      typeof content.revision !== "number"
    ) {
      throw new DomainError(
        "journal-corrupted",
        `任务关系索引非法（mission 不符或 schema 不匹配）: ${missionIdentifier}`,
      );
    }
    return {
      schemaVersion: MISSION_RELATION_SCHEMA_VERSION,
      missionIdentifier: content.missionIdentifier,
      revision: content.revision,
      projectIdentifier: content.projectIdentifier ?? null,
      conversationIdentifier: content.conversationIdentifier ?? null,
      mainAgentInstanceIdentifier: content.mainAgentInstanceIdentifier ?? null,
      taskSequenceIdentifier: content.taskSequenceIdentifier ?? null,
      taskIdentifier: content.taskIdentifier ?? null,
      sequenceOwnerAgentInstanceIdentifier:
        content.sequenceOwnerAgentInstanceIdentifier ?? null,
      taskBundleIdentifiers: content.taskBundleIdentifiers ?? [],
      agentInstanceIdentifiers: content.agentInstanceIdentifiers ?? [],
      recordedAtIso: content.recordedAtIso ?? this.nowIso(),
      updatedAtIso: content.updatedAtIso ?? this.nowIso(),
    };
  }

  /**
   * 登记/更新一条关系。
   *
   * 合并语义：只为**显式给出**的字段写入新值（`undefined` 保持原值）；数组字段用并集
   * （任务包/个体会随时间增加，登记不应把旧成员抹掉）。
   */
  async upsert(input: MissionRelationUpsertInput): Promise<MissionRelationRecord> {
    if (input.missionIdentifier.trim() === "") {
      throw new DomainError("invalid-task-chain", "任务关系必须绑定非空 mission 标识。");
    }
    return this.lock.runExclusive(async () => {
      const current = await this.read(input.missionIdentifier);
      const nowIso = this.nowIso();
      const next: MissionRelationRecord = {
        schemaVersion: MISSION_RELATION_SCHEMA_VERSION,
        missionIdentifier: input.missionIdentifier,
        revision: (current?.revision ?? 0) + 1,
        projectIdentifier: input.projectIdentifier ?? current?.projectIdentifier ?? null,
        conversationIdentifier:
          input.conversationIdentifier ?? current?.conversationIdentifier ?? null,
        mainAgentInstanceIdentifier:
          input.mainAgentInstanceIdentifier ??
          current?.mainAgentInstanceIdentifier ??
          null,
        taskSequenceIdentifier:
          input.taskSequenceIdentifier ?? current?.taskSequenceIdentifier ?? null,
        taskIdentifier: input.taskIdentifier ?? current?.taskIdentifier ?? null,
        sequenceOwnerAgentInstanceIdentifier:
          input.sequenceOwnerAgentInstanceIdentifier ??
          current?.sequenceOwnerAgentInstanceIdentifier ??
          null,
        taskBundleIdentifiers: mergeUnique(
          current?.taskBundleIdentifiers ?? [],
          input.taskBundleIdentifiers ?? [],
        ),
        agentInstanceIdentifiers: mergeUnique(
          current?.agentInstanceIdentifiers ?? [],
          input.agentInstanceIdentifiers ?? [],
        ),
        recordedAtIso: current?.recordedAtIso ?? nowIso,
        updatedAtIso: nowIso,
      };
      await cleanStaleTempFiles(this.relationsDirectoryPath, `${sanitizePathSegment(input.missionIdentifier)}.json`);
      await writeAtomicJson(this.relationFilePath(input.missionIdentifier), next);
      await backupExistingFile(
        this.relationFilePath(input.missionIdentifier),
        this.backupFilePath(input.missionIdentifier),
      );
      return next;
    });
  }

  /** 列出全部关系（只读；单条损坏会抛错，不静默跳过）。 */
  async listAll(): Promise<MissionRelationRecord[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.relationsDirectoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const missionIdentifiers = fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => fileName.slice(0, -".json".length))
      .map((encodedIdentifier) => decodePathSegment(encodedIdentifier));
    const records: MissionRelationRecord[] = [];
    for (const missionIdentifier of missionIdentifiers) {
      const record = await this.read(missionIdentifier);
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }
}

function mergeUnique(
  existingValues: readonly string[],
  nextValues: readonly string[],
): string[] {
  return [...new Set([...existingValues, ...nextValues])];
}
