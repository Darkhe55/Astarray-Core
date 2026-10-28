/**
 * GUI-03-05：项目工作时段配置存储（按项目隔离）。
 *
 * 只负责持久化/版本校验；判定复用 work-window-contract / work-window-gate。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import type { WorkWindowRule } from "../orchestration/work-window-contract.js";

export interface ProjectWorkWindowDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly projects: Record<string, WorkWindowRule[]>;
}

const DEFAULT_PROJECT_IDENTIFIER = "default";

function validateRule(rule: WorkWindowRule): void {
  if (
    rule.ruleIdentifier.trim() === "" ||
    (rule.mode !== "work-whitelist" && rule.mode !== "rest-blacklist") ||
    !Number.isInteger(rule.startMinuteOfDay) ||
    rule.startMinuteOfDay < 0 ||
    rule.startMinuteOfDay > 1439 ||
    !Number.isInteger(rule.endMinuteOfDay) ||
    rule.endMinuteOfDay < 0 ||
    rule.endMinuteOfDay > 1440 ||
    !Array.isArray(rule.weekdays) ||
    rule.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
    (rule.priority !== "periodic" && rule.priority !== "one-off") ||
    (rule.scopeKind !== "global" &&
      rule.scopeKind !== "project" &&
      rule.scopeKind !== "session")
  ) {
    throw new DomainError("invalid-task-chain", "工作时段规则非法: " + rule.ruleIdentifier);
  }
}

export class ProjectWorkWindowStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directory = path.join(options.baseDirectory, "work-window");
    this.filePath = path.join(directory, "config.json");
    this.backupFilePath = path.join(directory, "config.json.bak");
  }

  /**
   * 读取整份配置。
   *
   * 形参 `_projectIdentifier` 保留只为兼容既有调用方：本方法返回**全部项目**
   * 的规则，按项目取规则请用 `readRules(projectIdentifier)`。
   */
  async read(_projectIdentifier?: string): Promise<ProjectWorkWindowDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, revision: 1, projects: {} };
    }
    const content = readResult.content as Partial<ProjectWorkWindowDocument> & {
      rules?: WorkWindowRule[];
    };
    if (content.schemaVersion !== 1) {
      throw new DomainError("journal-corrupted", "工作时段配置非法。");
    }
    const projects =
      content.projects !== undefined && typeof content.projects === "object"
        ? content.projects
        : content.rules === undefined
          ? {}
          : { [DEFAULT_PROJECT_IDENTIFIER]: content.rules };
    return {
      schemaVersion: 1,
      revision: typeof content.revision === "number" ? content.revision : 1,
      projects,
    };
  }

  /** 返回指定项目的规则；未知项目返回空规则（默认全天可工作）。 */
  async readRules(projectIdentifier?: string): Promise<WorkWindowRule[]> {
    const document = await this.read();
    const key = projectIdentifier ?? DEFAULT_PROJECT_IDENTIFIER;
    return document.projects[key] ?? document.projects[DEFAULT_PROJECT_IDENTIFIER] ?? [];
  }

  async update(input: {
    projectIdentifier?: string;
    rules: WorkWindowRule[];
    expectedRevision: number;
  }): Promise<ProjectWorkWindowDocument> {
    for (const rule of input.rules) validateRule(rule);
    const key = input.projectIdentifier ?? DEFAULT_PROJECT_IDENTIFIER;
    return this.lock.runExclusive(async () => {
      const current = await this.read();
      if (current.revision !== input.expectedRevision) {
        throw new DomainError("stale-revision", "工作时段配置已被修改，请刷新。");
      }
      const next: ProjectWorkWindowDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        projects: {
          ...current.projects,
          [key]: input.rules.map((rule) => ({ ...rule })),
        },
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      return next;
    });
  }
}

