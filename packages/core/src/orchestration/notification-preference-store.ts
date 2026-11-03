/**
 * GUI-03 F01（2026-11-03）：**通知偏好的服务端持久化**。
 *
 * 与 GUI 既有 localStorage 偏好一一对应（`complete/failure/pending/system` 四个布尔），
 * 但以**认证用户 + 项目**为键落在状态目录，跨浏览器/设备一致。
 *
 * 纪律：
 * - 只接受四个已知布尔字段，**多一个字段即拒绝**（不静默丢弃）；
 * - `expectedRevision` 可选：提供时必须等于当前 revision，否则拒绝（防旧页面覆盖新值）；
 * - 文件损坏/缺失 ⇒ 返回**默认值**（不抛错、不伪造已有偏好）；
 * - 原子写；`updatedByUserId` 由认证主体注入，不接受调用方自填。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { AsyncMutex } from "../infra/async-mutex.js";

export const NOTIFICATION_PREFERENCE_SCHEMA_VERSION = 1;

export interface NotificationPreferences {
  readonly complete: boolean;
  readonly failure: boolean;
  readonly pending: boolean;
  readonly system: boolean;
}

/** 缺省值：与 GUI 面板一致（完成/失败/待处理开，系统通知关）。 */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  complete: true,
  failure: true,
  pending: true,
  system: false,
};

const PREFERENCE_KEYS = ["complete", "failure", "pending", "system"] as const;

export interface NotificationPreferenceRecord {
  readonly userId: string;
  readonly projectIdentifier: string;
  readonly preferences: NotificationPreferences;
  readonly revision: number;
  readonly updatedByUserId: string;
  readonly updatedAtIso: string;
}

export interface NotificationPreferenceDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly records: readonly NotificationPreferenceRecord[];
}

export class NotificationPreferenceStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(
    private readonly options: {
      baseDirectory: string;
      nowIso?: () => string;
    },
  ) {
    const directory = path.join(options.baseDirectory, "settings");
    this.filePath = path.join(directory, "notification-preferences.json");
    this.backupFilePath = `${this.filePath}.bak`;
  }

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  async readDocument(): Promise<NotificationPreferenceDocument> {
    /** 损坏/不可读 ⇒ 按"没有偏好"处理（不抛错、不伪造）。 */
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    ).catch(() => null);
    if (readResult === null) {
      return { schemaVersion: 1, documentRevision: 0, records: [] };
    }
    const content = readResult.content as Partial<NotificationPreferenceDocument> | null;
    if (content === null || typeof content !== "object" || !Array.isArray(content.records)) {
      return { schemaVersion: 1, documentRevision: 0, records: [] };
    }
    const records: NotificationPreferenceRecord[] = [];
    for (const raw of content.records) {
      const record = parseRecord(raw);
      if (record !== null) {
        records.push(record);
      }
    }
    return {
      schemaVersion: 1,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      records,
    };
  }

  /** 读取某用户在某项目下的偏好（缺省/损坏 ⇒ 默认值）。 */
  async read(input: {
    readonly userId: string;
    readonly projectIdentifier: string;
  }): Promise<{ readonly preferences: NotificationPreferences; readonly revision: number }> {
    const document = await this.readDocument();
    const record = document.records.find(
      (entry) =>
        entry.userId === input.userId &&
        entry.projectIdentifier === input.projectIdentifier,
    );
    if (record === undefined) {
      return { preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES }, revision: 0 };
    }
    return { preferences: { ...record.preferences }, revision: record.revision };
  }

  /**
   * 更新偏好。`expectedRevision` 提供时做乐观并发校验。
   * 返回写入后的 revision；非法字段/陈旧 revision 抛错且**不落盘**。
   */
  async update(input: {
    readonly userId: string;
    readonly projectIdentifier: string;
    readonly preferences: unknown;
    readonly expectedRevision?: number;
    readonly updatedByUserId: string;
  }): Promise<{ readonly preferences: NotificationPreferences; readonly revision: number }> {
    const preferences = validatePreferences(input.preferences);
    return this.writeLock.runExclusive(async () => {
      const document = await this.readDocument();
      const existing = document.records.find(
        (entry) =>
          entry.userId === input.userId &&
          entry.projectIdentifier === input.projectIdentifier,
      );
      const currentRevision = existing?.revision ?? 0;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== currentRevision
      ) {
        throw new DomainError(
          "stale-revision",
          `通知偏好已被更新（当前 revision ${String(currentRevision)}），拒绝用旧 revision 覆盖。`,
        );
      }
      const nextRevision = currentRevision + 1;
      const record: NotificationPreferenceRecord = {
        userId: input.userId,
        projectIdentifier: input.projectIdentifier,
        preferences,
        revision: nextRevision,
        updatedByUserId: input.updatedByUserId,
        updatedAtIso: this.nowIso(),
      };
      const records = [
        ...document.records.filter(
          (entry) =>
            !(
              entry.userId === input.userId &&
              entry.projectIdentifier === input.projectIdentifier
            ),
        ),
        record,
      ];
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        records,
      } satisfies NotificationPreferenceDocument);
      return { preferences: { ...preferences }, revision: nextRevision };
    });
  }
}

function validatePreferences(value: unknown): NotificationPreferences {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid-task-chain", "通知偏好必须是对象。");
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(PREFERENCE_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new DomainError(
      "invalid-task-chain",
      `通知偏好包含未知字段: ${unknownKeys.join(", ")}`,
    );
  }
  for (const key of PREFERENCE_KEYS) {
    if (typeof record[key] !== "boolean") {
      throw new DomainError(
        "invalid-task-chain",
        `通知偏好字段 ${key} 必须是布尔值。`,
      );
    }
  }
  return {
    complete: record.complete as boolean,
    failure: record.failure as boolean,
    pending: record.pending as boolean,
    system: record.system as boolean,
  };
}

function parseRecord(value: unknown): NotificationPreferenceRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.userId !== "string" ||
    typeof record.projectIdentifier !== "string" ||
    typeof record.revision !== "number" ||
    typeof record.updatedByUserId !== "string" ||
    typeof record.updatedAtIso !== "string"
  ) {
    return null;
  }
  try {
    return {
      userId: record.userId,
      projectIdentifier: record.projectIdentifier,
      preferences: validatePreferences(record.preferences),
      revision: record.revision,
      updatedByUserId: record.updatedByUserId,
      updatedAtIso: record.updatedAtIso,
    };
  } catch {
    return null;
  }
}
