/**
 * E 阶段 R21（2026-10-29）：**mission ↔ 权威任务序列 的持久索引**。
 *
 * 背景：`MainController` 只在内存里维护 `missionTaskSequences`；进程重启后丢失，
 * 于是 `task-ledger status` 与运行中插入都必须**手填** sequence 与 owner。
 *
 * 规则（保守）：
 * - 一个 mission 只对应一个序列；同一 mission 绑定到**不同**序列 ⇒ 拒绝（`journal-corrupted`），
 *   不静默改绑；
 * - 重复绑定同一序列 ⇒ 幂等（`didWrite:false`）；
 * - **不推断**：没有绑定就返回 `null`，调用方必须如实报告"未知"，不能按任务名/路径猜；
 * - 原子写 + 备份恢复；损坏读回空文档（宁可"未知"也不伪造）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";

export interface MissionSequenceBinding {
  readonly missionIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly ownerAgentInstanceIdentifier: string;
  readonly boundAtIso: string;
}

export interface MissionSequenceBindingDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly bindings: readonly MissionSequenceBinding[];
}

export class MissionSequenceBindingStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directoryPath = path.join(options.baseDirectory, "task-ledger");
    this.filePath = path.join(directoryPath, "mission-sequences.json");
    this.backupFilePath = `${this.filePath}.bak`;
  }

  async read(): Promise<MissionSequenceBindingDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, documentRevision: 0, bindings: [] };
    }
    const content = readResult.content as Partial<MissionSequenceBindingDocument> | null;
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
    readonly sequenceIdentifier: string;
    readonly ownerAgentInstanceIdentifier: string;
    readonly boundAtIso: string;
  }): Promise<{ readonly didWrite: boolean; readonly binding: MissionSequenceBinding }> {
    if (
      input.missionIdentifier.trim() === "" ||
      input.sequenceIdentifier.trim() === "" ||
      input.ownerAgentInstanceIdentifier.trim() === ""
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "mission/sequence/owner 三者都必须非空才能登记索引。",
      );
    }
    return await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const existing = document.bindings.find(
        (binding) => binding.missionIdentifier === input.missionIdentifier,
      );
      if (existing !== undefined) {
        if (existing.sequenceIdentifier !== input.sequenceIdentifier) {
          throw new DomainError(
            "journal-corrupted",
            `mission ${input.missionIdentifier} 已绑定序列 ${existing.sequenceIdentifier}，拒绝改绑 ${input.sequenceIdentifier}。`,
          );
        }
        return { didWrite: false, binding: existing };
      }
      const binding: MissionSequenceBinding = {
        missionIdentifier: input.missionIdentifier,
        sequenceIdentifier: input.sequenceIdentifier,
        ownerAgentInstanceIdentifier: input.ownerAgentInstanceIdentifier,
        boundAtIso: input.boundAtIso,
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        bindings: [...document.bindings, binding],
      } satisfies MissionSequenceBindingDocument);
      return { didWrite: true, binding };
    });
  }

  async readForMission(
    missionIdentifier: string,
  ): Promise<MissionSequenceBinding | null> {
    const document = await this.read();
    return (
      document.bindings.find(
        (binding) => binding.missionIdentifier === missionIdentifier,
      ) ?? null
    );
  }

  async list(): Promise<readonly MissionSequenceBinding[]> {
    return (await this.read()).bindings;
  }
}
