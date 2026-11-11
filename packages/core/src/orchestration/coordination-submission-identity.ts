import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

/**
 * COORD-01-03（卡 §3）：**稳定重试身份**。
 *
 * 卡内三条硬约束：
 * 1. 消息 ID 在**首次提交**时生成并持久化；传输重试、进程恢复沿用同一 ID；
 * 2. 上游缺稳定请求 ID 时，首次提交后返回**恢复令牌**（凭它找回同一条）；
 * 3. **不得按文本猜测**"两条相同用户输入就是重试" —— 相同文本、无请求 ID ⇒ 两条独立消息。
 *
 * 同身份 + 同请求 ID + 同内容 ⇒ 复用原记录；同身份 + 同请求 ID + **不同内容** ⇒ 冲突（拒绝，不覆盖）。
 */

export interface CoordinationSubmissionRecord {
  readonly sourceIdentifier: string;
  readonly requestIdentifier: string;
  readonly messageIdentifier: string;
  readonly recoveryToken: string;
  readonly contentFingerprint: string;
  readonly submittedAtIso: string;
}

interface CoordinationSubmissionDocument {
  readonly schemaVersion: 1;
  readonly partitionKey: string;
  readonly records: readonly CoordinationSubmissionRecord[];
  /** 恢复令牌 ⇒ 消息标识（便于按令牌找回）。 */
  readonly tokensToMessageIdentifiers: Readonly<Record<string, string>>;
}

export type CoordinationSubmissionOutcome =
  | { readonly outcome: "created"; readonly record: CoordinationSubmissionRecord }
  | { readonly outcome: "reused"; readonly record: CoordinationSubmissionRecord }
  | { readonly outcome: "conflict"; readonly existingRecord: CoordinationSubmissionRecord }
  | { readonly outcome: "invalid"; readonly reason: string };

export interface CoordinationSubmissionIdentityStoreOptions {
  readonly stateDirectory: string;
  readonly nowUnixMilliseconds?: () => number;
}

function sanitizeFileName(partitionKey: string): string {
  return partitionKey.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export class CoordinationSubmissionIdentityStore {
  private readonly stateDirectory: string;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: CoordinationSubmissionIdentityStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
  }

  private filePathFor(partitionKey: string): string {
    return path.join(this.stateDirectory, `${sanitizeFileName(partitionKey)}.json`);
  }

  private async loadDocument(partitionKey: string): Promise<CoordinationSubmissionDocument> {
    const primaryPath = this.filePathFor(partitionKey);
    const readResult = await readJsonWithBackupRecovery(primaryPath, `${primaryPath}.bak`);
    if (readResult === null) {
      return { schemaVersion: 1, partitionKey, records: [], tokensToMessageIdentifiers: {} };
    }
    return readResult.content as CoordinationSubmissionDocument;
  }

  private async saveDocument(document: CoordinationSubmissionDocument): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await writeAtomicJson(this.filePathFor(document.partitionKey), document);
  }

  /**
   * 提交一条待投递消息，确定其**稳定身份**。
   *
   * 没有 `requestIdentifier` 时**每次都生成新身份**（不按文本去重），并返回恢复令牌
   * 供调用方在丢失响应后找回；有 `requestIdentifier` 时按 (来源, 请求 ID) 判重。
   */
  async submit(input: {
    partitionKey: string;
    sourceIdentifier: string;
    requestIdentifier?: string;
    contentFingerprint: string;
  }): Promise<CoordinationSubmissionOutcome> {
    if (input.sourceIdentifier.trim() === "") {
      return { outcome: "invalid", reason: "缺少来源标识" };
    }
    if (input.contentFingerprint.trim() === "") {
      return { outcome: "invalid", reason: "缺少内容指纹（不得以空值判等）" };
    }

    const document = await this.loadDocument(input.partitionKey);
    const requestIdentifier = input.requestIdentifier;

    if (requestIdentifier !== undefined && requestIdentifier.trim() !== "") {
      const existing = document.records.find(
        (record) =>
          record.sourceIdentifier === input.sourceIdentifier &&
          record.requestIdentifier === requestIdentifier,
      );
      if (existing !== undefined) {
        if (existing.contentFingerprint !== input.contentFingerprint) {
          /** 同请求 ID 异内容：拒绝并交回冲突记录，不覆盖已存在的身份。 */
          return { outcome: "conflict", existingRecord: existing };
        }
        return { outcome: "reused", record: existing };
      }
    }

    const record: CoordinationSubmissionRecord = {
      sourceIdentifier: input.sourceIdentifier,
      requestIdentifier: requestIdentifier?.trim() ?? `generated:${randomUUID()}`,
      messageIdentifier: `message:${randomUUID()}`,
      recoveryToken: `recovery:${randomUUID()}`,
      contentFingerprint: input.contentFingerprint,
      submittedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
    };
    await this.saveDocument({
      ...document,
      records: [...document.records, record],
      tokensToMessageIdentifiers: {
        ...document.tokensToMessageIdentifiers,
        [record.recoveryToken]: record.messageIdentifier,
      },
    });
    return { outcome: "created", record };
  }

  /** 凭恢复令牌找回提交记录（进程恢复 / 响应丢失场景）。 */
  async resumeByRecoveryToken(input: {
    partitionKey: string;
    recoveryToken: string;
  }): Promise<CoordinationSubmissionRecord | null> {
    const document = await this.loadDocument(input.partitionKey);
    const messageIdentifier = document.tokensToMessageIdentifiers[input.recoveryToken];
    if (messageIdentifier === undefined) return null;
    return (
      document.records.find((record) => record.messageIdentifier === messageIdentifier) ?? null
    );
  }
}
