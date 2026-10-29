/**
 * GOAL-02 R3（2026-10-29）：**mission ↔ 目标 绑定**。
 *
 * 门禁解析器的输入是 mission 标识，而目标契约按 goalIdentifier 存。
 * 本模块只维护这一条映射，**不承载目标状态**（状态在 `GoalModeStateStore`）。
 *
 * 语义：
 * - 一个 mission 只能绑定一个目标（重复绑定到不同目标 ⇒ 拒绝，避免"换目标掩盖暂停"）；
 * - 解绑不改历史，只删除映射；
 * - 没有绑定 ⇒ 解析器返回 null（目标模式不参与该 mission）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";

export interface GoalMissionBinding {
  readonly missionIdentifier: string;
  readonly goalIdentifier: string;
  readonly boundAtIso: string;
}

export interface GoalMissionBindingDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly bindings: readonly GoalMissionBinding[];
}

export class GoalMissionBindingStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directoryPath = path.join(options.baseDirectory, "goal-mode");
    this.filePath = path.join(directoryPath, "mission-bindings.json");
    this.backupFilePath = `${this.filePath}.bak`;
  }

  async read(): Promise<GoalMissionBindingDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, documentRevision: 0, bindings: [] };
    }
    const content = readResult.content as Partial<GoalMissionBindingDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      !Array.isArray(content.bindings)
    ) {
      return { schemaVersion: 1, documentRevision: 0, bindings: [] };
    }
    return {
      schemaVersion: 1,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      bindings: content.bindings,
    };
  }

  async bind(input: {
    readonly missionIdentifier: string;
    readonly goalIdentifier: string;
    readonly boundAtIso: string;
  }): Promise<GoalMissionBinding> {
    if (input.missionIdentifier.trim() === "" || input.goalIdentifier.trim() === "") {
      throw new DomainError(
        "invalid-task-chain",
        "目标是绑定必须同时提供 mission 与 goal 标识。",
      );
    }
    return await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const existing = document.bindings.find(
        (binding) => binding.missionIdentifier === input.missionIdentifier,
      );
      if (existing !== undefined) {
        if (existing.goalIdentifier !== input.goalIdentifier) {
          throw new DomainError(
            "task-sequence-permission-denied",
            `mission ${input.missionIdentifier} 已绑定目标 ${existing.goalIdentifier}，拒绝改绑 ${input.goalIdentifier}（需先显式解绑）。`,
          );
        }
        return existing;
      }
      const binding: GoalMissionBinding = {
        missionIdentifier: input.missionIdentifier,
        goalIdentifier: input.goalIdentifier,
        boundAtIso: input.boundAtIso,
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        bindings: [...document.bindings, binding],
      } satisfies GoalMissionBindingDocument);
      return binding;
    });
  }

  async readGoalIdentifier(missionIdentifier: string): Promise<string | null> {
    const document = await this.read();
    return (
      document.bindings.find(
        (binding) => binding.missionIdentifier === missionIdentifier,
      )?.goalIdentifier ?? null
    );
  }

  async list(): Promise<readonly GoalMissionBinding[]> {
    return (await this.read()).bindings;
  }

  async unbind(missionIdentifier: string): Promise<boolean> {
    return await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const nextBindings = document.bindings.filter(
        (binding) => binding.missionIdentifier !== missionIdentifier,
      );
      if (nextBindings.length === document.bindings.length) {
        return false;
      }
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        bindings: nextBindings,
      } satisfies GoalMissionBindingDocument);
      return true;
    });
  }
}
