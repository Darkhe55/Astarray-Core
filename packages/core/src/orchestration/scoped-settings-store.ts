/**
 * GUI-03-02：项目/会话作用域配置存储。
 *
 * 只存**覆盖值**，应用默认值仍由现有 store 提供；读取方必须显式合并。
 * 每次写入使用 expectedRevision CAS、原子写和备份，不直接改权限门禁。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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

/**
 * ADR-0205 补充：**会话权限覆盖的解析**（会话优先于项目；mission 不得顶替会话）。
 */
export function resolveScopedPermissionOverride(input: {
  readonly document: ScopedSettingsDocument;
  readonly projectIdentifier: string | null;
  readonly conversationIdentifier: string | null;
}): ScopedPermissionOverride | undefined {
  if (input.conversationIdentifier !== null && input.conversationIdentifier !== "") {
    const sessionPermission =
      input.document.sessions[input.conversationIdentifier]?.permission;
    if (sessionPermission !== undefined) {
      return sessionPermission;
    }
  }
  if (input.projectIdentifier === null || input.projectIdentifier === "") {
    return undefined;
  }
  return input.document.projects[input.projectIdentifier]?.permission;
}

export interface ScopedSettingsStoreOptions {
  baseDirectory: string;
  nowMilliseconds?: () => number;
  /** GUI-04-02：跨进程写锁等待上限（默认 5000ms）。 */
  lockTimeoutMilliseconds?: number;
  /** GUI-04-02：锁持有者标识前缀（默认 scoped-settings；测试可注入）。 */
  ownerIdentifier?: string;
  /** GUI-04-02：进程存活判定（默认 process.kill(pid, 0)；测试可注入）。 */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * GUI-04-04（2026-11-03）：**会话上下文覆盖的解析**。
 *
 * 会话作用域只认**稳定会话标识**（`conversationIdentifier`）；mission 只是执行投影，
 * **不得用 missionId 顶替**（旧摘要缺会话时按"无会话覆盖"处理）。
 * 会话覆盖优先于项目覆盖。
 */
export function resolveScopedContextOverride(input: {
  readonly document: ScopedSettingsDocument;
  readonly projectIdentifier: string | null;
  readonly conversationIdentifier: string | null;
}): ScopedContextOverride | undefined {
  if (input.conversationIdentifier !== null && input.conversationIdentifier !== "") {
    const sessionContext =
      input.document.sessions[input.conversationIdentifier]?.context;
    if (sessionContext !== undefined) {
      return sessionContext;
    }
  }
  if (input.projectIdentifier === null || input.projectIdentifier === "") {
    return undefined;
  }
  return input.document.projects[input.projectIdentifier]?.context;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function emptyDocument(): ScopedSettingsDocument {
  return { schemaVersion: 1, revision: 1, projects: {}, sessions: {} };
}

export class ScopedSettingsStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly recoveryDirectoryPath: string;
  private readonly lockFilePath: string;
  private readonly lockTimeoutMilliseconds: number;
  private readonly ownerIdentifier: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly nowMilliseconds: () => number;
  private readonly storeLock = new AsyncMutex();
  private cachedDocument: ScopedSettingsDocument | null = null;

  constructor(options: ScopedSettingsStoreOptions) {
    const directory = path.join(options.baseDirectory, "scoped-settings");
    this.filePath = path.join(directory, "settings.json");
    this.backupFilePath = path.join(directory, "settings.json.bak");
    this.recoveryDirectoryPath = path.join(directory, "recovery");
    this.lockFilePath = path.join(directory, "settings.lock");
    this.lockTimeoutMilliseconds = options.lockTimeoutMilliseconds ?? 5_000;
    this.ownerIdentifier = `${options.ownerIdentifier ?? "scoped-settings"}:${process.pid}`;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  /**
   * GUI-04-02：**跨进程写锁**（目录级独占文件锁）。
   *
   * - 持锁者记录 pid + token；等待有界（默认 5s）；
   * - 只有**持锁进程已不存在**时才接管；存活进程即使超过 expiresAt 也不删除（只等待到超时）；
   * - 超时抛 `scoped-settings-lock-timeout`（不静默并发写）。
   */
  private async acquireCrossProcessLock(
    reason: string,
  ): Promise<{ release: () => Promise<void> }> {
    const deadline = this.nowMilliseconds() + this.lockTimeoutMilliseconds;
    const token = `${this.ownerIdentifier}:${randomUUID()}`;
    const payload = JSON.stringify({
      token,
      pid: process.pid,
      ownerIdentifier: this.ownerIdentifier,
      reason,
      acquiredAtIso: new Date(this.nowMilliseconds()).toISOString(),
    });
    await fs.mkdir(path.dirname(this.lockFilePath), { recursive: true });
    for (;;) {
      try {
        const handle = await fs.open(this.lockFilePath, "wx");
        try {
          await handle.writeFile(payload, "utf8");
        } finally {
          await handle.close();
        }
        return {
          release: async () => {
            try {
              const raw = await fs.readFile(this.lockFilePath, "utf8");
              const holder = JSON.parse(raw) as { token?: unknown };
              if (holder.token === token) {
                await fs.unlink(this.lockFilePath);
              }
            } catch {
              // 已被接管/删除 ⇒ 无需释放
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      let holderPid: number | null = null;
      let isParsed = false;
      try {
        const raw = await fs.readFile(this.lockFilePath, "utf8");
        const holder = JSON.parse(raw) as { pid?: unknown };
        holderPid = typeof holder.pid === "number" ? holder.pid : null;
        isParsed = typeof holder.pid === "number";
      } catch {
        // 读不到/半写入 ⇒ 保持 isParsed=false，按"正在获取"等待。
      }
      if (isParsed && holderPid !== null && !this.isProcessAlive(holderPid)) {
        // 持锁进程已不存在 ⇒ 允许接管；并发接管时 wx 仍只有一个赢家。
        await fs.unlink(this.lockFilePath).catch(() => undefined);
        continue;
      }
      // 锁刚创建但内容尚未写完（或损坏）⇒ 视为"正在获取"，等待而非抢占。
      if (this.nowMilliseconds() >= deadline) {
        throw new DomainError(
          "scoped-settings-lock-timeout",
          `作用域配置写锁等待超时（持有者 pid=${String(holderPid)}）。`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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

  /**
   * GUI-04-02：**覆盖前旧版本保全**。
   *
   * 首次创建（无任何覆盖且 revision ≤ 1）不制造空备份；其余写入先把当前文档
   * 追加到 `recovery/history.jsonl`，失败则**拒绝覆盖**（抛错且不写主文件）。
   */
  private async captureRecoveryPoint(
    current: ScopedSettingsDocument,
    reason: string,
  ): Promise<void> {
    const hasExistingOverrides =
      Object.keys(current.projects).length > 0 ||
      Object.keys(current.sessions).length > 0;
    if (!hasExistingOverrides && current.revision <= 1) {
      return;
    }
    const line = JSON.stringify({
      recordedAtIso: new Date(this.nowMilliseconds()).toISOString(),
      reason,
      previous: current,
    });
    try {
      await fs.mkdir(this.recoveryDirectoryPath, { recursive: true });
      await fs.appendFile(
        path.join(this.recoveryDirectoryPath, "history.jsonl"),
        `${line}\n`,
        "utf8",
      );
    } catch (error) {
      throw new DomainError(
        "scoped-settings-backup-failed",
        `旧版本备份失败，拒绝覆盖: ${(error as Error).message}`,
      );
    }
  }

  /** GUI-04-02 回滚入口：列出可恢复的历史版本（最新的在前）。 */
  async listRecoveryEntries(): Promise<
    Array<{
      readonly recordedAtIso: string;
      readonly reason: string;
      readonly previous: ScopedSettingsDocument;
    }>
  > {
    const historyPath = path.join(this.recoveryDirectoryPath, "history.jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(historyPath, "utf8");
    } catch {
      return [];
    }
    const entries: Array<{
      recordedAtIso: string;
      reason: string;
      previous: ScopedSettingsDocument;
    }> = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as {
          recordedAtIso?: unknown;
          reason?: unknown;
          previous?: unknown;
        };
        const previous = parsed.previous as ScopedSettingsDocument | undefined;
        if (
          typeof parsed.recordedAtIso !== "string" ||
          typeof parsed.reason !== "string" ||
          previous === undefined ||
          previous.schemaVersion !== 1 ||
          typeof previous.revision !== "number"
        ) {
          continue;
        }
        entries.push({
          recordedAtIso: parsed.recordedAtIso,
          reason: parsed.reason,
          previous,
        });
      } catch {
        // 跳过损坏行，不伪造历史
      }
    }
    return entries.reverse();
  }

  /**
   * GUI-04-02 回滚：把指定历史版本写回为**新 revision**（不改写历史、不降低 revision）。
   * `expectedRevision` 用于 CAS，避免覆盖并发写入；恢复动作本身也写 recovery point。
   */
  async restoreRecoveryEntry(input: {
    readonly recordedAtIso: string;
    readonly expectedRevision: number;
  }): Promise<ScopedSettingsDocument> {
    return this.storeLock.runExclusive(async () => {
      const fileLock = await this.acquireCrossProcessLock("restore");
      try {
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
        const entries = await this.listRecoveryEntries();
        const entry = entries.find(
          (candidate) => candidate.recordedAtIso === input.recordedAtIso,
        );
        if (entry === undefined) {
          throw new DomainError("invalid-task-chain", "未找到该恢复点。");
        }
        const restored: ScopedSettingsDocument = {
          ...entry.previous,
          revision: current.revision + 1,
        };
        await this.captureRecoveryPoint(current, "restore");
        await writeAtomicJson(this.filePath, restored);
        await backupExistingFile(this.filePath, this.backupFilePath);
        this.cachedDocument = restored;
        return restored;
      } finally {
        await fileLock.release();
      }
    });
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
      input.configuredMaximumGlobalContextTokenCount < -1
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "上下文预算必须为非负整数，或 -1 表示恢复继承。",
      );
    }
    return this.storeLock.runExclusive(async () => {
      const fileLock = await this.acquireCrossProcessLock("update-context");
      try {
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
        /** GUI-04-02：`-1` 表示恢复继承 ⇒ 删除 context 字段（不是写 0）。 */
        const isClear = input.configuredMaximumGlobalContextTokenCount === -1;
        const nextEntry = { ...previous };
        if (isClear) {
          delete (nextEntry as { context?: unknown }).context;
        } else {
          (nextEntry as { context?: unknown }).context = {
            configuredMaximumGlobalContextTokenCount:
              input.configuredMaximumGlobalContextTokenCount,
            updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
            updatedByUserId: input.updatedByUserId,
          };
        }
        const nextBucket = { ...bucket };
        if (Object.keys(nextEntry).length === 0) {
          delete nextBucket[input.identifier];
        } else {
          nextBucket[input.identifier] = nextEntry;
        }
        const next: ScopedSettingsDocument = {
          ...current,
          revision: current.revision + 1,
          [input.scope === "project" ? "projects" : "sessions"]: nextBucket,
        };
        await this.captureRecoveryPoint(current, "update");
        await writeAtomicJson(this.filePath, next);
        await backupExistingFile(this.filePath, this.backupFilePath);
        this.cachedDocument = next;
        return next;
      } finally {
        await fileLock.release();
      }
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
      const fileLock = await this.acquireCrossProcessLock("update-permission");
      try {
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
        /** GUI-04-02：`null` 表示恢复继承 ⇒ 删除 permission 字段（不是写 null）。 */
        const nextEntry = { ...previous };
        if (input.permissionProfileId === null) {
          delete (nextEntry as { permission?: unknown }).permission;
        } else {
          (nextEntry as { permission?: unknown }).permission = {
            permissionProfileId: input.permissionProfileId,
            updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
            updatedByUserId: input.updatedByUserId,
          };
        }
        const nextBucket = { ...bucket };
        if (Object.keys(nextEntry).length === 0) {
          delete nextBucket[input.identifier];
        } else {
          nextBucket[input.identifier] = nextEntry;
        }
        const next: ScopedSettingsDocument = {
          ...current,
          revision: current.revision + 1,
          [input.scope === "project" ? "projects" : "sessions"]: nextBucket,
        };
        await this.captureRecoveryPoint(current, "update");
        await writeAtomicJson(this.filePath, next);
        await backupExistingFile(this.filePath, this.backupFilePath);
        this.cachedDocument = next;
        return next;
      } finally {
        await fileLock.release();
      }
    });
  }
}
