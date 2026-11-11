import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

/**
 * COORD-01-02（卡 §4.7）：**应用失败的持久退避**。
 *
 * 卡内数字：1/2/4/8/16 秒有界退避，单轮自动尝试**最多 5 次**；计数**持久化，重启不清零**；
 * 超限转 `blocked` 并给出可查询原因；只有人工或有权控制器显式重试才开新一轮。
 */

/** 单轮自动尝试上限（卡 §4.7 固定值）。 */
export const COORDINATION_MAXIMUM_AUTOMATIC_ATTEMPTS = 5;

/** 有界退避：第 N 次失败后的等待（毫秒），超限后不再自动重试。 */
export const COORDINATION_BACKOFF_MILLISECONDS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

export interface CoordinationRetryRecord {
  readonly messageIdentifier: string;
  readonly attemptCount: number;
  readonly nextAttemptAtUnixMilliseconds: number;
  readonly isBlocked: boolean;
  readonly reason: string | null;
}

interface CoordinationRetryDocument {
  readonly schemaVersion: 1;
  readonly partitionKey: string;
  readonly records: readonly CoordinationRetryRecord[];
}

export interface CoordinationRetryStoreOptions {
  readonly stateDirectory: string;
  readonly nowUnixMilliseconds?: () => number;
}

function sanitizeFileName(partitionKey: string): string {
  return partitionKey.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export class CoordinationRetryStore {
  private readonly stateDirectory: string;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: CoordinationRetryStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
  }

  private filePathFor(partitionKey: string): string {
    return path.join(this.stateDirectory, `${sanitizeFileName(partitionKey)}.json`);
  }

  private async loadDocument(partitionKey: string): Promise<CoordinationRetryDocument> {
    const primaryPath = this.filePathFor(partitionKey);
    const readResult = await readJsonWithBackupRecovery(primaryPath, `${primaryPath}.bak`);
    if (readResult === null) {
      return { schemaVersion: 1, partitionKey, records: [] };
    }
    return readResult.content as CoordinationRetryDocument;
  }

  private async saveDocument(document: CoordinationRetryDocument): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await writeAtomicJson(this.filePathFor(document.partitionKey), document);
  }

  async readRetryRecord(input: {
    partitionKey: string;
    messageIdentifier: string;
  }): Promise<CoordinationRetryRecord | null> {
    const document = await this.loadDocument(input.partitionKey);
    return (
      document.records.find((record) => record.messageIdentifier === input.messageIdentifier) ?? null
    );
  }

  /** 现在是否允许自动尝试（首次尝试、退避已到期、且未 blocked）。 */
  async isEligibleForAutomaticAttempt(input: {
    partitionKey: string;
    messageIdentifier: string;
  }): Promise<boolean> {
    const record = await this.readRetryRecord(input);
    if (record === null) return true;
    if (record.isBlocked) return false;
    return record.nextAttemptAtUnixMilliseconds <= this.nowUnixMilliseconds();
  }

  /**
   * 记录一次**应用失败**，返回下一次允许尝试的时间或"已转 blocked"。
   * 计数持久化：同一消息重启后继续累积，不会清零。
   */
  async recordFailure(input: {
    partitionKey: string;
    messageIdentifier: string;
    reason: string;
  }): Promise<CoordinationRetryRecord> {
    const document = await this.loadDocument(input.partitionKey);
    const existing = document.records.find(
      (record) => record.messageIdentifier === input.messageIdentifier,
    );
    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    const isBlocked = attemptCount >= COORDINATION_MAXIMUM_AUTOMATIC_ATTEMPTS;
    const backoffMilliseconds = isBlocked
      ? 0
      : (COORDINATION_BACKOFF_MILLISECONDS[attemptCount - 1] ??
        COORDINATION_BACKOFF_MILLISECONDS[COORDINATION_BACKOFF_MILLISECONDS.length - 1] ??
        0);
    const record: CoordinationRetryRecord = {
      messageIdentifier: input.messageIdentifier,
      attemptCount,
      nextAttemptAtUnixMilliseconds: isBlocked
        ? Number.POSITIVE_INFINITY
        : this.nowUnixMilliseconds() + backoffMilliseconds,
      isBlocked,
      reason: isBlocked ? `自动尝试已达 ${String(COORDINATION_MAXIMUM_AUTOMATIC_ATTEMPTS)} 次上限：${input.reason}` : input.reason,
    };
    await this.saveDocument({
      ...document,
      records: [...document.records.filter((candidate) => candidate.messageIdentifier !== input.messageIdentifier), record],
    });
    return record;
  }

  /** 应用成功 ⇒ 清除该消息的失败记录。 */
  async recordSuccess(input: { partitionKey: string; messageIdentifier: string }): Promise<void> {
    const document = await this.loadDocument(input.partitionKey);
    const remaining = document.records.filter(
      (record) => record.messageIdentifier !== input.messageIdentifier,
    );
    if (remaining.length === document.records.length) return;
    await this.saveDocument({ ...document, records: remaining });
  }

  /** 人工/有权控制器显式重试：清空该消息计数，允许开始新一轮自动尝试。 */
  async resetForExplicitRetry(input: {
    partitionKey: string;
    messageIdentifier: string;
  }): Promise<void> {
    await this.recordSuccess(input);
  }
}
