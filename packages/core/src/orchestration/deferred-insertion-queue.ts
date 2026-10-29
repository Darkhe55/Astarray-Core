/**
 * E 阶段 R24（2026-10-29）：**推迟到下一组的插入请求的显式队列**。
 *
 * 背景：运行中插入在"非安全点"时走 `deferred-to-sequence` —— 任务确实进了权威序列，
 * 但"下一组要消费它"只存在于返回原因文本里；进程重启后**没有可消费的清单**。
 *
 * 规则（保守）：
 * - 按 `insertRequestIdentifier` 幂等：重复入队同一请求 ⇒ 不新增；
 * - 同一请求但 `taskIdentifier`/序列不同 ⇒ `journal-corrupted`（不静默覆盖）；
 * - **只排队，不消费**：消费必须发生在安全点（后续检查点接），这里不做任何派发；
 * - 原子写 + 备份恢复；损坏读回空队列（宁可"没有待办"也不伪造）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";

export interface DeferredInsertionEntry {
  readonly insertRequestIdentifier: string;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly ownerAgentInstanceIdentifier: string;
  readonly reason: string;
  readonly enqueuedAtIso: string;
}

export interface DeferredInsertionQueueDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly pending: readonly DeferredInsertionEntry[];
  readonly consumed: readonly (DeferredInsertionEntry & {
    readonly consumedAtIso: string;
    readonly consumedByGroupIdentifier: string;
  })[];
}

export class DeferredInsertionQueueStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly maximumConsumedEntries: number;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string; maximumConsumedEntries?: number }) {
    const directoryPath = path.join(options.baseDirectory, "task-ledger");
    this.filePath = path.join(directoryPath, "deferred-insertions.json");
    this.backupFilePath = `${this.filePath}.bak`;
    /** R25：`consumed` 有界（缺省 200），超出丢弃最旧（只丢弃已消费历史，不动 pending）。 */
    this.maximumConsumedEntries = Math.max(1, options.maximumConsumedEntries ?? 200);
  }

  async read(): Promise<DeferredInsertionQueueDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, documentRevision: 0, pending: [], consumed: [] };
    }
    const content = readResult.content as Partial<DeferredInsertionQueueDocument> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      !Array.isArray(content.pending) ||
      !Array.isArray(content.consumed)
    ) {
      return { schemaVersion: 1, documentRevision: 0, pending: [], consumed: [] };
    }
    return {
      schemaVersion: 1,
      documentRevision:
        typeof content.documentRevision === "number" ? content.documentRevision : 0,
      pending: content.pending,
      consumed: content.consumed,
    };
  }

  async enqueue(
    entry: DeferredInsertionEntry,
  ): Promise<{ readonly didEnqueue: boolean }> {
    if (
      entry.insertRequestIdentifier.trim() === "" ||
      entry.missionIdentifier.trim() === "" ||
      entry.taskIdentifier.trim() === ""
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "推迟插入条目必须带请求标识、mission 与 task。",
      );
    }
    return await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const existing = document.pending.find(
        (candidate) =>
          candidate.insertRequestIdentifier === entry.insertRequestIdentifier,
      );
      if (existing !== undefined) {
        if (
          existing.taskIdentifier !== entry.taskIdentifier ||
          existing.sequenceIdentifier !== entry.sequenceIdentifier
        ) {
          throw new DomainError(
            "journal-corrupted",
            `插入请求 ${entry.insertRequestIdentifier} 已排队到不同任务/序列，拒绝覆盖。`,
          );
        }
        return { didEnqueue: false };
      }
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        pending: [...document.pending, entry],
        consumed: document.consumed,
      } satisfies DeferredInsertionQueueDocument);
      return { didEnqueue: true };
    });
  }

  async listPending(missionIdentifier?: string): Promise<readonly DeferredInsertionEntry[]> {
    const document = await this.read();
    return missionIdentifier === undefined
      ? document.pending
      : document.pending.filter(
          (entry) => entry.missionIdentifier === missionIdentifier,
        );
  }

  /**
   * 标记已消费（由**安全点消费方**调用；本模块不自行判定安全点）。
   *
   * 只把条目从 `pending` 移到 `consumed` 并记录组标识；不存在 ⇒ 返回 false（不伪造成功）。
   */
  async markConsumed(input: {
    readonly insertRequestIdentifier: string;
    readonly consumedAtIso: string;
    readonly consumedByGroupIdentifier: string;
  }): Promise<{ readonly didConsume: boolean }> {
    return await this.writeLock.runExclusive(async () => {
      const document = await this.read();
      const target = document.pending.find(
        (candidate) =>
          candidate.insertRequestIdentifier === input.insertRequestIdentifier,
      );
      if (target === undefined) {
        return { didConsume: false };
      }
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        documentRevision: document.documentRevision + 1,
        pending: document.pending.filter(
          (candidate) =>
            candidate.insertRequestIdentifier !== input.insertRequestIdentifier,
        ),
        consumed: [
          ...document.consumed,
          {
            ...target,
            consumedAtIso: input.consumedAtIso,
            consumedByGroupIdentifier: input.consumedByGroupIdentifier,
          },
        ].slice(-this.maximumConsumedEntries),
      } satisfies DeferredInsertionQueueDocument);
      return { didConsume: true };
    });
  }
}
