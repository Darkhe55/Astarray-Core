/**
 * GUI-03-04：实验能力目录与启停记录。
 *
 * 只列出 EXP-01 已存在的三项实验；没有产品运行时消费者的项目不可启用。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";

export interface ExperimentCatalogEntry {
  readonly experimentIdentifier: string;
  readonly displayName: string;
  readonly description: string;
  readonly defaultEnabled: false;
  readonly contractStatus: "contract-only" | "partial" | "runtime-ready";
  readonly runtimeConsumerWired: boolean;
  readonly blockedReason: string | null;
}

export const EXPERIMENT_CATALOG: ReadonlyArray<ExperimentCatalogEntry> = [
  {
    experimentIdentifier: "FOLD-01",
    displayName: "等价折叠与可复用工具",
    description: "工作流折叠候选、包登记与生命周期。",
    defaultEnabled: false,
    contractStatus: "partial",
    runtimeConsumerWired: false,
    blockedReason: "契约/包级判定已实现，真实产品复用入口与成本收益未接线。",
  },
  {
    experimentIdentifier: "EXPLORE-01",
    displayName: "边界探索与方法发现",
    description: "有界试验、预算与证据收敛。",
    defaultEnabled: false,
    contractStatus: "partial",
    runtimeConsumerWired: false,
    blockedReason: "契约/判定层已实现，产品执行与调度未接线。",
  },
  {
    experimentIdentifier: "CURATE-01",
    displayName: "授权式历史梳理",
    description: "历史整理、摘要与增量维护。",
    defaultEnabled: false,
    contractStatus: "partial",
    runtimeConsumerWired: false,
    blockedReason: "契约/执行判定已实现，周期调度与历史视图未接线。",
  },
];

export interface ExperimentSettingsDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly enabledExperimentIdentifiers: string[];
}

export class ExperimentSettingsStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directory = path.join(options.baseDirectory, "experiments");
    this.filePath = path.join(directory, "settings.json");
    this.backupFilePath = path.join(directory, "settings.json.bak");
  }

  async read(): Promise<ExperimentSettingsDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, revision: 1, enabledExperimentIdentifiers: [] };
    }
    const content = readResult.content as Partial<ExperimentSettingsDocument>;
    if (
      content.schemaVersion !== 1 ||
      !Array.isArray(content.enabledExperimentIdentifiers)
    ) {
      return { schemaVersion: 1, revision: 1, enabledExperimentIdentifiers: [] };
    }
    return {
      schemaVersion: 1,
      revision: typeof content.revision === "number" ? content.revision : 1,
      enabledExperimentIdentifiers: content.enabledExperimentIdentifiers.filter(
        (identifier): identifier is string => typeof identifier === "string",
      ),
    };
  }

  async update(input: {
    enabledExperimentIdentifiers: string[];
    expectedRevision: number;
  }): Promise<ExperimentSettingsDocument> {
    const known = new Set(EXPERIMENT_CATALOG.map((entry) => entry.experimentIdentifier));
    for (const identifier of input.enabledExperimentIdentifiers) {
      if (!known.has(identifier)) {
        throw new DomainError("invalid-task-chain", "未知实验: " + identifier);
      }
      const entry = EXPERIMENT_CATALOG.find(
        (candidate) => candidate.experimentIdentifier === identifier,
      );
      if (entry !== undefined && !entry.runtimeConsumerWired) {
        throw new DomainError(
          "invalid-task-chain",
          "实验缺少产品运行时消费者，不能启用: " + identifier,
        );
      }
    }
    return this.lock.runExclusive(async () => {
      const current = await this.read();
      if (current.revision !== input.expectedRevision) {
        throw new DomainError("stale-revision", "实验配置已被修改，请刷新。");
      }
      const next: ExperimentSettingsDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        enabledExperimentIdentifiers: [...new Set(input.enabledExperimentIdentifiers)],
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      return next;
    });
  }
}
