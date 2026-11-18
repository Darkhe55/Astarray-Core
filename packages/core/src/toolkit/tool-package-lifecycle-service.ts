/**
 * GUI-03-05：工具包生命周期持久化服务。
 *
 * 控制语义委托 ToolPackageVersionController；本服务只负责加载/保存快照，
 * 不做自动联网安装，也不绕过版本差异/重新授权门禁。
 */
import path from "node:path";
import { withFileLock } from "../infra/file-lock.js";
import { DomainError } from "../core/errors.js";

import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import {
  ToolPackageVersionController,
  type ToolPackageVersionRegistration,
  type ToolPackageVersionLifecycleStatus,
} from "./tool-package-version-controller.js";

interface PersistedLifecycle {
  schemaVersion: 1;
  /** WIRING-04 §36.2：文档版本（旧文件缺省按 0），用于跨进程 CAS。 */
  documentRevision?: number;
  versions: Array<{
    registration: ToolPackageVersionRegistration;
    status: ToolPackageVersionLifecycleStatus;
  }>;
  projectLocks: Array<{
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
    isEnabled: boolean;
    revision: number;
  }>;
  callHistory: ReturnType<ToolPackageVersionController["listAllCallRecords"]>;
  pendingSwitches: ReturnType<ToolPackageVersionController["listPendingSwitches"]>;
}

export class ToolPackageLifecycleService {
  private readonly controller = new ToolPackageVersionController();
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly writeLock = new AsyncMutex();
  private isLoaded = false;
  private loadedDocumentRevision = 0;

  constructor(options: { baseDirectory: string }) {
    const directory = path.join(options.baseDirectory, "tool-packages");
    this.filePath = path.join(directory, "lifecycle.json");
    this.backupFilePath = path.join(directory, "lifecycle.json.bak");
  }

  private async load(): Promise<void> {
    if (this.isLoaded) return;
    this.isLoaded = true;
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) return;
    const persisted = readResult.content as PersistedLifecycle;
    if (persisted.schemaVersion !== 1) return;
    this.loadedDocumentRevision =
      typeof persisted.documentRevision === "number" ? persisted.documentRevision : 0;
    this.controller.restoreFromSnapshot({
      versions: persisted.versions ?? [],
      projectLocks: persisted.projectLocks ?? [],
      callHistory: persisted.callHistory ?? [],
      pendingSwitches: persisted.pendingSwitches ?? [],
    });
  }

  private async persist(): Promise<void> {
    /**
     * WIRING-04 §36.2：跨进程临界区 + 预期文档版本校验。
     * 进程内状态快照只有在磁盘版本仍是载入时那一版时才允许落盘，避免旧快照覆盖新状态。
     */
    await withFileLock({ lockFilePath: `${this.filePath}.lock` }, async () => {
    const currentPersisted = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    ).catch(() => null);
    const currentRevision =
      typeof (currentPersisted?.content as { documentRevision?: unknown } | null)?.documentRevision ===
      "number"
        ? ((currentPersisted?.content as { documentRevision: number }).documentRevision)
        : 0;
    if (currentRevision !== this.loadedDocumentRevision) {
      throw new DomainError(
        "stale-revision",
        `工具包生命周期文档已被其他进程更新（现有 ${String(
          currentRevision,
        )}，本进程基于 ${String(this.loadedDocumentRevision)}）：拒绝用旧快照覆盖。`,
      );
    }
    const snapshot: PersistedLifecycle = {
      schemaVersion: 1,
      documentRevision: this.loadedDocumentRevision + 1,
      versions: this.controller.listRegisteredVersions(),
      projectLocks: this.controller.listProjectLocks(),
      callHistory: this.controller.listAllCallRecords(),
      pendingSwitches: this.controller.listPendingSwitches(),
    };
    await writeAtomicJson(this.filePath, snapshot);
    await backupExistingFile(this.filePath, this.backupFilePath);
    this.loadedDocumentRevision += 1;
    });
  }

  async install(registration: ToolPackageVersionRegistration): Promise<void> {
    return this.writeLock.runExclusive(async () => {
      await this.load();
      this.controller.registerVersion(registration);
      await this.persist();
    });
  }

  async list(): Promise<{
    versions: ReturnType<ToolPackageVersionController["listRegisteredVersions"]>;
    locks: ReturnType<ToolPackageVersionController["listProjectLocks"]>;
    pendingSwitches: ReturnType<ToolPackageVersionController["listPendingSwitches"]>;
  }> {
    // 外部安装器可能已写入文件：列表每次从磁盘重载，避免缓存空快照。
    this.isLoaded = false;
    await this.load();
    return {
      versions: this.controller.listRegisteredVersions(),
      locks: this.controller.listProjectLocks(),
      pendingSwitches: this.controller.listPendingSwitches(),
    };
  }

  async lock(input: {
    projectIdentifier: string;
    toolPackageId: string;
    version: number;
    contentHash: string;
  }) {
    return this.writeLock.runExclusive(async () => {
      await this.load();
      const outcome = this.controller.lockProjectToVersion(input);
      if (outcome.isApplied) await this.persist();
      return outcome;
    });
  }

  async enable(input: { projectIdentifier: string; toolPackageId: string; version: number }) {
    return this.writeLock.runExclusive(async () => {
      await this.load();
      const outcome = this.controller.enableForProject(input);
      if (outcome.isApplied) await this.persist();
      return outcome;
    });
  }

  async upgrade(input: {
    projectIdentifier: string;
    toolPackageId: string;
    targetVersion: number;
    targetContentHash: string;
    isReauthorized: boolean;
  }) {
    return this.writeLock.runExclusive(async () => {
      await this.load();
      const outcome = this.controller.upgradeProjectVersion({
        projectIdentifier: input.projectIdentifier,
        toolPackageId: input.toolPackageId,
        toVersion: input.targetVersion,
        hasVerifiedReauthorizationGrant: input.isReauthorized,
      });
      if (outcome.isApplied) await this.persist();
      return outcome;
    });
  }

  async rollback(input: {
    projectIdentifier: string;
    toolPackageId: string;
    targetVersion: number;
  }) {
    return this.writeLock.runExclusive(async () => {
      await this.load();
      const outcome = this.controller.rollbackProjectVersion({
        projectIdentifier: input.projectIdentifier,
        toolPackageId: input.toolPackageId,
        toVersion: input.targetVersion,
      });
      if (outcome.isApplied) await this.persist();
      return outcome;
    });
  }

  async disable(input: { projectIdentifier: string; toolPackageId: string }) {
    return this.writeLock.runExclusive(async () => {
      await this.load();
      const outcome = this.controller.disableForProject(input);
      if (outcome.isApplied) await this.persist();
      return outcome;
    });
  }
}


