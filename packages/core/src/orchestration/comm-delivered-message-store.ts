/**
 * COMM-01 重放去重的**持久化层**（2026-11-14，用户裁决第 2 条）。
 *
 * 用户口径：「**静默去重**，返回原结果，并在结果中带**重复次数标记**」。
 *
 * 为什么必须有持久化：只在内存里去重只能防同一进程内的重复；
 * 服务重启后同一条消息会被当成"新消息"再执行一次——那不是静默去重，是重复副作用。
 *
 * 设计取舍（刻意写清，避免以后被随手改成"默认安全"的假象）：
 * - 损坏/不可解析的存档 **不会**被当成"历史为空"：那会把已投递消息当新消息再执行。
 *   因此 `recordDelivery` 在检测到存档损坏时**拒绝**（fail-closed），由调用方决定人工处置。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import {
  type DeliveredMessageRecord,
  type ReplayDedupeOutcome,
  dedupeReplayedMessage,
} from "./comm-message-routing-decisions.js";

export interface CommDeliveredMessageDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly records: readonly DeliveredMessageRecord[];
}

export interface CommDeliveredMessageReadResult {
  readonly document: CommDeliveredMessageDocument;
  /**
   * 存档是否可判定为可信：
   * - `true`：文件不存在（首次使用）或结构合法；
   * - `false`：文件存在但无法解析/结构损坏 ⇒ **不得**据此认为"没有历史"。
   */
  readonly isHistoryTrustworthy: boolean;
}

const EMPTY_DOCUMENT: CommDeliveredMessageDocument = {
  schemaVersion: 1,
  revision: 0,
  records: [],
};

export class CommDeliveredMessageStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lock = new AsyncMutex();

  constructor(options: { readonly baseDirectory: string }) {
    const directory = path.join(options.baseDirectory, "comm-delivered-messages");
    this.filePath = path.join(directory, "delivered.json");
    this.backupFilePath = path.join(directory, "delivered.json.bak");
  }

  async read(): Promise<CommDeliveredMessageReadResult> {
    const readResult = await readJsonWithBackupRecovery(this.filePath, this.backupFilePath);
    if (readResult === null) {
      return { document: EMPTY_DOCUMENT, isHistoryTrustworthy: true };
    }
    const content = readResult.content as Partial<CommDeliveredMessageDocument> | null;
    if (content === null || typeof content !== "object" || !Array.isArray(content.records)) {
      return { document: EMPTY_DOCUMENT, isHistoryTrustworthy: false };
    }
    return {
      document: {
        schemaVersion: 1,
        revision: typeof content.revision === "number" ? content.revision : 0,
        records: content.records,
      },
      isHistoryTrustworthy: true,
    };
  }

  async findDelivered(messageIdentifier: string): Promise<DeliveredMessageRecord | null> {
    const { document } = await this.read();
    return document.records.find((record) => record.messageIdentifier === messageIdentifier) ?? null;
  }

  /**
   * 记录一次投递并返回去重结论。
   *
   * 语义与 `dedupeReplayedMessage` 完全一致（静默、返回首次结果、次数累加），
   * 差别只在于结果**落盘**，重启后仍然生效。
   */
  async recordDelivery(input: {
    readonly messageIdentifier: string;
    readonly incomingResult: unknown;
    readonly deliveredAtIso: string;
  }): Promise<ReplayDedupeOutcome> {
    return await this.lock.runExclusive(async () => {
      const { document, isHistoryTrustworthy } = await this.read();
      if (!isHistoryTrustworthy) {
        throw new DomainError(
          "mission-not-found",
          "重放去重存档损坏：拒绝把已投递消息当作新消息再执行（需人工处置存档）",
        );
      }
      const existingRecord =
        document.records.find(
          (record) => record.messageIdentifier === input.messageIdentifier,
        ) ?? null;
      const { outcome, recordToStore } = dedupeReplayedMessage({
        messageIdentifier: input.messageIdentifier,
        existingRecord,
        incomingResult: input.incomingResult,
        deliveredAtIso: input.deliveredAtIso,
      });
      const records =
        existingRecord === null
          ? [...document.records, recordToStore]
          : document.records.map((record) =>
              record.messageIdentifier === input.messageIdentifier ? recordToStore : record,
            );
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: document.revision + 1,
        records,
      } satisfies CommDeliveredMessageDocument);
      return outcome;
    });
  }

}
