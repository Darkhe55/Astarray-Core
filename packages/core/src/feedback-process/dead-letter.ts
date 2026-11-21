/**
 * 2026-11-21（用户裁决 C）：反馈客户端**死信**的只读/人工处置入口。
 *
 * 永久性拒绝的消息不再无限重试，而是落到
 * `<state>/feedback-client-dead-letter/<sha256(idempotencyKey)>.json`。
 *
 * 本模块提供人工入口（CLI/SDK 共用）：
 * - `list`：只读清点（损坏文件如实计数，不抛错、不静默丢弃）；
 * - `requeue`：把死信**原样**写回补送 outbox（内容不改；下一次心跳重试）；
 * - `remove`：人工确认后清除。
 *
 * 纪律：文件名只接受 `[a-f0-9]{64}.json`（防路径穿越）；不信任目录里任意文件名。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";
import type { FeedbackMessage } from "../core/types.js";

export const FEEDBACK_DEAD_LETTER_SCHEMA_VERSION = 1;

export interface FeedbackDeadLetterRecord {
  readonly schemaVersion: number;
  readonly rejectedAtIso: string;
  readonly rejectionCode: string;
  readonly rejectionReason: string;
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly message: FeedbackMessage;
}

export interface FeedbackDeadLetterEntry {
  readonly fileName: string;
  readonly record: FeedbackDeadLetterRecord;
}

const SAFE_FILE_NAME = /^[a-f0-9]{64}\.json$/;

function isSafeFileName(fileName: string): boolean {
  return SAFE_FILE_NAME.test(fileName);
}

export class FeedbackDeadLetterStore {
  private readonly baseDirectory: string;

  constructor(input: { readonly baseDirectory: string }) {
    this.baseDirectory = input.baseDirectory;
  }

  get directoryPath(): string {
    return path.join(this.baseDirectory, "feedback-client-dead-letter");
  }

  private outboxPathFor(idempotencyKey: string): string {
    const digest = createHash("sha256").update(idempotencyKey).digest("hex");
    return path.join(this.baseDirectory, "feedback-client-outbox", `${digest}.json`);
  }

  /** 只读清点：坏文件不抛错，计入 `invalidCount`（不静默丢弃）。 */
  async list(): Promise<{
    readonly entries: readonly FeedbackDeadLetterEntry[];
    readonly invalidCount: number;
  }> {
    let names: string[];
    try {
      names = await fs.readdir(this.directoryPath);
    } catch {
      return { entries: [], invalidCount: 0 };
    }
    const entries: FeedbackDeadLetterEntry[] = [];
    let invalidCount = 0;
    for (const fileName of names.sort()) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const record = await this.read(fileName);
      if (record === null) {
        invalidCount += 1;
        continue;
      }
      entries.push({ fileName, record });
    }
    return { entries, invalidCount };
  }

  async read(fileName: string): Promise<FeedbackDeadLetterRecord | null> {
    if (!isSafeFileName(fileName)) {
      return null;
    }
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.directoryPath, fileName), "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Partial<FeedbackDeadLetterRecord>;
    if (
      typeof record.rejectionCode !== "string" ||
      typeof record.rejectionReason !== "string" ||
      typeof record.idempotencyKey !== "string" ||
      typeof record.messageId !== "string" ||
      record.message === undefined ||
      record.message === null
    ) {
      return null;
    }
    return {
      schemaVersion:
        typeof record.schemaVersion === "number"
          ? record.schemaVersion
          : FEEDBACK_DEAD_LETTER_SCHEMA_VERSION,
      rejectedAtIso: typeof record.rejectedAtIso === "string" ? record.rejectedAtIso : "",
      rejectionCode: record.rejectionCode,
      rejectionReason: record.rejectionReason,
      idempotencyKey: record.idempotencyKey,
      messageId: record.messageId,
      message: record.message as FeedbackMessage,
    };
  }

  /**
   * 把死信**原样**写回补送 outbox，然后删除死信。
   * 原文不改（重放必须与原消息逐字节一致；是否再次被拒由子进程判定）。
   */
  async requeue(
    fileName: string,
  ): Promise<"requeued" | "not-found" | "already-queued" | "invalid"> {
    if (!isSafeFileName(fileName)) {
      return "invalid";
    }
    const record = await this.read(fileName);
    if (record === null) {
      return "not-found";
    }
    const outboxPath = this.outboxPathFor(record.idempotencyKey);
    try {
      await fs.access(outboxPath);
      return "already-queued";
    } catch {
      // 不在补送队列里，继续写回。
    }
    try {
      await writeAtomicJson(outboxPath, record.message);
    } catch {
      return "invalid";
    }
    await fs.rm(path.join(this.directoryPath, fileName), { force: true });
    return "requeued";
  }

  /** 人工清除（确认不再需要该消息）。 */
  async remove(fileName: string): Promise<boolean> {
    if (!isSafeFileName(fileName)) {
      return false;
    }
    try {
      await fs.rm(path.join(this.directoryPath, fileName), { force: false });
      return true;
    } catch {
      return false;
    }
  }
}
