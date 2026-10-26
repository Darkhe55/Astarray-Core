/**
 * GUI-03-05：工具包生命周期持久化服务。
 *
 * 控制语义委托 ToolPackageVersionController；本服务只负责加载/保存快照，
 * 不做自动联网安装，也不绕过版本差异/重新授权门禁。
 */
import path from "node:path";

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
    this.controller.restoreFromSnapshot({
      versions: persisted.versions ?? [],
      projectLocks: persisted.projectLocks ?? [],
      callHistory: persisted.callHistory ?? [],
      pendingSwitches: persisted.pendingSwitches ?? [],
    });
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedLifecycle = {
      schemaVersion: 1,
      versions: this.controller.listRegisteredVersions(),
      projectLocks: this.controller.listProjectLocks(),
      callHistory: this.controller.listAllCallRecords(),
      pendingSwitches: this.controller.listPendingSwitches(),
    };
    await writeAtomicJson(this.filePath, snapshot);
    await backupExistingFile(this.filePath, this.backupFilePath);
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


