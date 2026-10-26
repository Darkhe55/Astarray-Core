/**
 * GUI-03-02：项目/会话作用域配置存储。
 *
 * 只存**覆盖值**，应用默认值仍由现有 store 提供；读取方必须显式合并。
 * 每次写入使用 expectedRevision CAS、原子写和备份，不直接改权限门禁。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";

export interface ScopedContextOverride {
  readonly configuredMaximumGlobalContextTokenCount: number;
  readonly updatedAtIso: string;
  readonly updatedByUserId: string;
}

export interface ScopedPermissionOverride {
  readonly permissionProfileId: string | null;
  readonly updatedAtIso: string;
  readonly updatedByUserId: string;
}

export interface ScopedSettingsDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly projects: Record<
    string,
    {
      readonly context?: ScopedContextOverride;
      readonly permission?: ScopedPermissionOverride;
    }
  >;
  readonly sessions: Record<
    string,
    {
      readonly context?: ScopedContextOverride;
      readonly permission?: ScopedPermissionOverride;
    }
  >;
}

export interface ScopedSettingsStoreOptions {
  baseDirectory: string;
  nowMilliseconds?: () => number;
}

function emptyDocument(): ScopedSettingsDocument {
  return { schemaVersion: 1, revision: 1, projects: {}, sessions: {} };
}

export class ScopedSettingsStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly nowMilliseconds: () => number;
  private readonly storeLock = new AsyncMutex();
  private cachedDocument: ScopedSettingsDocument | null = null;

  constructor(options: ScopedSettingsStoreOptions) {
    const directory = path.join(options.baseDirectory, "scoped-settings");
    this.filePath = path.join(directory, "settings.json");
    this.backupFilePath = path.join(directory, "settings.json.bak");
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  async read(): Promise<ScopedSettingsDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      this.cachedDocument = emptyDocument();
      return this.cachedDocument;
    }
    const content = readResult.content as Partial<ScopedSettingsDocument>;
    if (content.schemaVersion !== 1 || typeof content.revision !== "number") {
      throw new DomainError("journal-corrupted", "作用域配置文件非法。");
    }
    this.cachedDocument = {
      schemaVersion: 1,
      revision: content.revision,
      projects: content.projects ?? {},
      sessions: content.sessions ?? {},
    };
    return this.cachedDocument;
  }

  /** 同步只读缓存；启动时 preload，写入后更新。 */
  getCached(): ScopedSettingsDocument {
    return this.cachedDocument ?? emptyDocument();
  }

  async updateContext(input: {
    scope: "project" | "session";
    identifier: string;
    expectedRevision: number;
    configuredMaximumGlobalContextTokenCount: number;
    updatedByUserId: string;
  }): Promise<ScopedSettingsDocument> {
    if (input.identifier.trim() === "") {
      throw new DomainError("invalid-task-chain", "作用域标识不能为空。");
    }
    if (
      !Number.isInteger(input.configuredMaximumGlobalContextTokenCount) ||
      input.configuredMaximumGlobalContextTokenCount < 0
    ) {
      throw new DomainError("invalid-task-chain", "上下文预算必须为非负整数。");
    }
    return this.storeLock.runExclusive(async () => {
      const current = await this.read();
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "stale-revision",
          "作用域配置 revision 不匹配: 现有 " +
            current.revision +
            "，期望 " +
            input.expectedRevision,
        );
      }
      const bucket = input.scope === "project" ? current.projects : current.sessions;
      const previous = bucket[input.identifier] ?? {};
      const next: ScopedSettingsDocument = {
        ...current,
        revision: current.revision + 1,
        [input.scope === "project" ? "projects" : "sessions"]: {
          ...bucket,
          [input.identifier]: {
            ...previous,
            context: {
              configuredMaximumGlobalContextTokenCount:
                input.configuredMaximumGlobalContextTokenCount,
              updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
              updatedByUserId: input.updatedByUserId,
            },
          },
        },
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      this.cachedDocument = next;
      return next;
    });
  }

  async updatePermission(input: {
    scope: "project" | "session";
    identifier: string;
    expectedRevision: number;
    permissionProfileId: string | null;
    updatedByUserId: string;
  }): Promise<ScopedSettingsDocument> {
    if (input.identifier.trim() === "") {
      throw new DomainError("invalid-task-chain", "作用域标识不能为空。");
    }
    return this.storeLock.runExclusive(async () => {
      const current = await this.read();
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "stale-revision",
          "作用域配置 revision 不匹配: 现有 " +
            current.revision +
            "，期望 " +
            input.expectedRevision,
        );
      }
      const bucket = input.scope === "project" ? current.projects : current.sessions;
      const previous = bucket[input.identifier] ?? {};
      const next: ScopedSettingsDocument = {
        ...current,
        revision: current.revision + 1,
        [input.scope === "project" ? "projects" : "sessions"]: {
          ...bucket,
          [input.identifier]: {
            ...previous,
            permission: {
              permissionProfileId: input.permissionProfileId,
              updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
              updatedByUserId: input.updatedByUserId,
            },
          },
        },
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      this.cachedDocument = next;
      return next;
    });
  }
}
