/**
 * 计划 R9（2026-10-29）：**独立完成裁决的本地存储**。
 *
 * 背景：严格完成门禁需要两类证据 —— 完成收据（R6–R8）与**独立裁决**；
 * 后者此前只有读取端口 `completionVerdictReader` 却没有存储，也没有写入方。
 *
 * 规则（保守，防止"自批"被写成裁决）：
 * - 必须绑定 mission / task / 裁决者个体标识；裁决只有 `accepted` / `rejected`；
 * - `rejected` **必须**给理由；`accepted` 的理由可为空（不强迫写废话）；
 * - **同 mission/task 已有裁决**：内容相同 ⇒ 幂等；不同 ⇒ `journal-corrupted` **拒绝覆盖**
 *   （裁决是证据，不能被事后改写）；
 * - 原子写 + 备份恢复；损坏读回 `null`（不伪造裁决）。
 *
 * 边界：本模块**不判断**裁决者是否独立（那是 `IndependentReviewGate` 的职责）；
 * 它只保证"裁决被如实记录、不可被覆盖"。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";

export type CompletionVerdictKind = "accepted" | "rejected";

export interface CompletionVerdictRecord {
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly verdict: CompletionVerdictKind;
  readonly reasons: readonly string[];
  /** 做出裁决的个体（具体 Agent 实例标识，不是角色名）。 */
  readonly deciderAgentInstanceIdentifier: string;
  readonly decidedAtIso: string;
}

export interface StoredCompletionVerdict {
  readonly schemaVersion: 1;
  readonly record: CompletionVerdictRecord;
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class CompletionVerdictStore {
  private readonly directoryPath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "completion-verdicts");
  }

  private verdictFilePath(missionIdentifier: string, taskIdentifier: string): string {
    return path.join(
      this.directoryPath,
      sanitizePathSegment(missionIdentifier),
      `${sanitizePathSegment(taskIdentifier)}.json`,
    );
  }

  async save(record: CompletionVerdictRecord): Promise<{ readonly didWrite: boolean }> {
    if (record.missionIdentifier.trim() === "" || record.taskIdentifier.trim() === "") {
      throw new DomainError(
        "invalid-task-chain",
        "完成裁决必须绑定 mission 与 task 标识。",
      );
    }
    if (record.deciderAgentInstanceIdentifier.trim() === "") {
      throw new DomainError(
        "invalid-task-chain",
        "完成裁决必须绑定裁决者个体标识（不接受匿名/角色名）。",
      );
    }
    if (Number.isNaN(Date.parse(record.decidedAtIso))) {
      throw new DomainError("invalid-task-chain", "完成裁决时间非法。");
    }
    if (record.verdict === "rejected" && record.reasons.length === 0) {
      throw new DomainError(
        "invalid-task-chain",
        "拒绝裁决必须给出理由（不允许无理由 rejected）。",
      );
    }
    return await this.writeLock.runExclusive(async () => {
      const existing = await this.read(record.missionIdentifier, record.taskIdentifier);
      if (existing !== null) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new DomainError(
            "journal-corrupted",
            `同一 mission/task 已有不同内容的完成裁决，拒绝覆盖: ${record.missionIdentifier}/${record.taskIdentifier}`,
          );
        }
        return { didWrite: false };
      }
      await writeAtomicJson(
        this.verdictFilePath(record.missionIdentifier, record.taskIdentifier),
        { schemaVersion: 1, record } satisfies StoredCompletionVerdict,
      );
      return { didWrite: true };
    });
  }

  async read(
    missionIdentifier: string,
    taskIdentifier: string,
  ): Promise<CompletionVerdictRecord | null> {
    const filePath = this.verdictFilePath(missionIdentifier, taskIdentifier);
    const readResult = await readJsonWithBackupRecovery(filePath, `${filePath}.bak`);
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as Partial<StoredCompletionVerdict> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      content.schemaVersion !== 1 ||
      content.record === undefined ||
      content.record === null
    ) {
      return null;
    }
    return content.record as CompletionVerdictRecord;
  }

  async listForMission(missionIdentifier: string): Promise<CompletionVerdictRecord[]> {
    const { readdir } = await import("node:fs/promises");
    const missionDirectory = path.join(
      this.directoryPath,
      sanitizePathSegment(missionIdentifier),
    );
    let fileNames: string[];
    try {
      fileNames = await readdir(missionDirectory);
    } catch {
      return [];
    }
    const records: CompletionVerdictRecord[] = [];
    for (const fileName of fileNames.filter((name) => name.endsWith(".json")).sort()) {
      const taskIdentifier = fileName.slice(0, -".json".length);
      const record = await this.read(missionIdentifier, taskIdentifier);
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }
}
