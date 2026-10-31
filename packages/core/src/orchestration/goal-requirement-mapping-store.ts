/**
 * R72（2026-10-31）：**目标要求 ↔ 任务节点映射**（K2）。
 *
 * 背景：卡 01 要求 GoalContract 里带"任务节点映射"，但仓内**没有写入方**：
 * 契约字段是静态的，而任务节点通常在执行过程中才确定。K2 提供一个**独立的映射存储**，
 * 不改契约 revision、不重置预算，只回答"这条要求由哪些任务节点支撑"。
 *
 * 规则（保守）：
 * - 映射按 goal 分文件：`<state>/goal-mode/requirement-mappings/<goal>.json`；
 * - 记录写入时的 `contractRevision`；与当前契约不一致时**读取方应视为失效**（运行时负责校验）；
 * - 同一 requirement 多次绑定 ⇒ **覆盖**（后写者为准），并递增文档 revision；
 * - 空任务列表 ⇒ 视为"清除该映射"；
 * - 原子写 + 备份恢复；损坏读回空文档（不伪造映射）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";

export interface GoalRequirementTaskMapping {
  readonly requirementIdentifier: string;
  readonly taskNodeIdentifiers: readonly string[];
}

export interface GoalRequirementMappingDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly goalIdentifier: string;
  /** 写入时绑定的契约 revision；与当前契约不一致 ⇒ 映射失效。 */
  readonly contractRevision: number;
  readonly mappings: readonly GoalRequirementTaskMapping[];
  readonly updatedAtIso: string;
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class GoalRequirementMappingStore {
  private readonly directoryPath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "goal-mode", "requirement-mappings");
  }

  private filePath(goalIdentifier: string): string {
    return path.join(this.directoryPath, `${sanitizePathSegment(goalIdentifier)}.json`);
  }

  async read(goalIdentifier: string): Promise<GoalRequirementMappingDocument | null> {
    const filePath = this.filePath(goalIdentifier);
    const readResult = await readJsonWithBackupRecovery(filePath, `${filePath}.bak`);
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as Partial<GoalRequirementMappingDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      content.schemaVersion !== 1 ||
      !Array.isArray(content.mappings)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      goalIdentifier: content.goalIdentifier ?? goalIdentifier,
      contractRevision:
        typeof content.contractRevision === "number" ? content.contractRevision : 0,
      mappings: content.mappings,
      updatedAtIso: content.updatedAtIso ?? new Date(0).toISOString(),
    };
  }

  /**
   * 绑定/覆盖一条要求的任务节点。
   *
   * `taskNodeIdentifiers` 为空 ⇒ 清除该映射。返回写入后的文档。
   */
  async setMapping(input: {
    readonly goalIdentifier: string;
    readonly contractRevision: number;
    readonly requirementIdentifier: string;
    readonly taskNodeIdentifiers: readonly string[];
  }): Promise<GoalRequirementMappingDocument> {
    if (
      input.goalIdentifier.trim() === "" ||
      input.requirementIdentifier.trim() === ""
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "要求映射必须同时提供 goalIdentifier 与 requirementIdentifier。",
      );
    }
    const normalizedTaskIdentifiers = [
      ...new Set(
        input.taskNodeIdentifiers
          .map((taskIdentifier) => taskIdentifier.trim())
          .filter((taskIdentifier) => taskIdentifier !== ""),
      ),
    ];
    return await this.writeLock.runExclusive(async () => {
      const existing = await this.read(input.goalIdentifier);
      const otherMappings = (existing?.mappings ?? []).filter(
        (mapping) => mapping.requirementIdentifier !== input.requirementIdentifier,
      );
      const nextMappings =
        normalizedTaskIdentifiers.length === 0
          ? otherMappings
          : [
              ...otherMappings,
              {
                requirementIdentifier: input.requirementIdentifier,
                taskNodeIdentifiers: normalizedTaskIdentifiers,
              },
            ];
      const next: GoalRequirementMappingDocument = {
        schemaVersion: 1,
        documentRevision: (existing?.documentRevision ?? 0) + 1,
        goalIdentifier: input.goalIdentifier,
        contractRevision: input.contractRevision,
        mappings: nextMappings,
        updatedAtIso: new Date().toISOString(),
      };
      await writeAtomicJson(this.filePath(input.goalIdentifier), next);
      return next;
    });
  }

  /** 读取映射表；与传入的契约 revision 不一致 ⇒ 返回 `null`（失效，不猜）。 */
  async readForContractRevision(
    goalIdentifier: string,
    contractRevision: number,
  ): Promise<GoalRequirementMappingDocument | null> {
    const document = await this.read(goalIdentifier);
    if (document === null || document.contractRevision !== contractRevision) {
      return null;
    }
    return document;
  }
}
