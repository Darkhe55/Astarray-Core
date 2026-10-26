/**
 * GUI-03 / 方案 A：Agent 模型绑定（只存选择，不存 runtime）。
 *
 * 层级解析：application → project → session → agent。
 * 子级只覆盖自己；未覆盖的字段继续继承。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";

export type ModelBindingScope = "application" | "project" | "session" | "agent";

export interface ModelBinding {
  readonly providerId: string;
  readonly modelIdentifier: string;
  readonly updatedAtIso: string;
  readonly updatedByUserId: string;
  readonly appliedAtIso?: string;
  readonly lastAppliedMissionId?: string;
  readonly lastFailureReason?: string;
  readonly lastFailedAtIso?: string;
}

export interface ModelBindingDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly bindings: Record<string, ModelBinding>;
}

export interface ResolvedModelBinding {
  readonly binding: ModelBinding;
  readonly scope: ModelBindingScope;
  readonly scopeIdentifier: string;
}

export interface ModelBindingStoreOptions {
  baseDirectory: string;
  nowMilliseconds?: () => number;
}

function key(scope: ModelBindingScope, identifier: string): string {
  return scope + ":" + identifier;
}

function emptyDocument(): ModelBindingDocument {
  return { schemaVersion: 1, revision: 1, bindings: {} };
}

export class AgentModelBindingStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly nowMilliseconds: () => number;
  private readonly lock = new AsyncMutex();

  constructor(options: ModelBindingStoreOptions) {
    const directory = path.join(options.baseDirectory, "model-bindings");
    this.filePath = path.join(directory, "bindings.json");
    this.backupFilePath = path.join(directory, "bindings.json.bak");
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  async read(): Promise<ModelBindingDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) return emptyDocument();
    const content = readResult.content as Partial<ModelBindingDocument>;
    if (content.schemaVersion !== 1 || typeof content.revision !== "number") {
      throw new DomainError("journal-corrupted", "模型绑定文件非法。");
    }
    return {
      schemaVersion: 1,
      revision: content.revision,
      bindings: content.bindings ?? {},
    };
  }

  /** 解析有效绑定；全部缺失返回 null（调用方继续使用当前 Provider 配置）。 */
  async resolve(input: {
    projectIdentifier: string | null;
    sessionIdentifier: string | null;
    agentInstanceId: string | null;
  }): Promise<ResolvedModelBinding | null> {
    const document = await this.read();
    const candidates: Array<[ModelBindingScope, string | null]> = [
      ["agent", input.agentInstanceId],
      ["session", input.sessionIdentifier],
      ["project", input.projectIdentifier],
      ["application", "application"],
    ];
    for (const [scope, identifier] of candidates) {
      if (identifier === null || identifier === "") continue;
      const binding = document.bindings[key(scope, identifier)];
      if (binding !== undefined) {
        return { binding, scope, scopeIdentifier: identifier };
      }
    }
    return null;
  }

  async setBinding(input: {
    scope: ModelBindingScope;
    scopeIdentifier: string;
    providerId: string;
    modelIdentifier: string;
    expectedRevision: number;
    updatedByUserId: string;
  }): Promise<ModelBindingDocument> {
    if (
      input.scopeIdentifier.trim() === "" ||
      input.providerId.trim() === "" ||
      input.modelIdentifier.trim() === ""
    ) {
      throw new DomainError("invalid-task-chain", "绑定 scope/provider/model 不能为空。");
    }
    return this.lock.runExclusive(async () => {
      const current = await this.read();
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "stale-revision",
          "模型绑定 revision 不匹配: 现有 " + current.revision + "，期望 " + input.expectedRevision,
        );
      }
      const next: ModelBindingDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        bindings: {
          ...current.bindings,
          [key(input.scope, input.scopeIdentifier)]: {
            providerId: input.providerId,
            modelIdentifier: input.modelIdentifier,
            updatedAtIso: new Date(this.nowMilliseconds()).toISOString(),
            updatedByUserId: input.updatedByUserId,
          },
        },
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      return next;
    });
  }

  /** mission 实际获取该绑定后标记已生效（不改变选择本身）。 */
  async markApplied(input: {
    scope: ModelBindingScope;
    scopeIdentifier: string;
    missionId: string;
  }): Promise<void> {
    await this.lock.runExclusive(async () => {
      const current = await this.read();
      const bindingKey = key(input.scope, input.scopeIdentifier);
      const binding = current.bindings[bindingKey];
      if (binding === undefined) return;
      const next: ModelBindingDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        bindings: {
          ...current.bindings,
          [bindingKey]: {
            ...binding,
            appliedAtIso: new Date(this.nowMilliseconds()).toISOString(),
            lastAppliedMissionId: input.missionId,
          },
        },
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
    });
  }
  /** mission 解析或获取 runtime 失败时记录；不改变当前选择。 */
  async markFailed(input: {
    scope: ModelBindingScope;
    scopeIdentifier: string;
    reason: string;
  }): Promise<void> {
    await this.lock.runExclusive(async () => {
      const current = await this.read();
      const bindingKey = key(input.scope, input.scopeIdentifier);
      const binding = current.bindings[bindingKey];
      if (binding === undefined) return;
      const next: ModelBindingDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        bindings: {
          ...current.bindings,
          [bindingKey]: {
            ...binding,
            lastFailureReason: input.reason,
            lastFailedAtIso: new Date(this.nowMilliseconds()).toISOString(),
          },
        },
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
    });
  }
  async clearBinding(input: {
    scope: ModelBindingScope;
    scopeIdentifier: string;
    expectedRevision: number;
  }): Promise<ModelBindingDocument> {
    return this.lock.runExclusive(async () => {
      const current = await this.read();
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "stale-revision",
          "模型绑定 revision 不匹配: 现有 " + current.revision + "，期望 " + input.expectedRevision,
        );
      }
      const nextBindings = { ...current.bindings };
      delete nextBindings[key(input.scope, input.scopeIdentifier)];
      const next: ModelBindingDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        bindings: nextBindings,
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      return next;
    });
  }
}


