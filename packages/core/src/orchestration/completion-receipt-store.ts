/**
 * ALIGN-03-03 / 计划 R6（2026-10-29）：**完成收据的本地存储**。
 *
 * 背景：`completion-receipt.ts` 只有契约与纯判定；**没有任何地方落盘收据**，
 * 所以 `isCompletionReceiptRequired` 打开后只能一律阻断（ADR-0079 的已知缺口）。
 * 本模块补"收据落盘/读取"这一层，供严格模式的 `completionReceiptReader` 使用。
 *
 * 规则（刻意保守，防止把收据当橡皮章）：
 * - 写入前用 `evaluateCompletionReceipt` 校验（缺失/矛盾/非法字段 ⇒ 拒绝落盘）；
 * - **同 mission/task 已有收据**：内容相同 ⇒ 幂等返回；内容不同 ⇒ **拒绝覆盖**
 *   （`journal-corrupted`），避免事后改写完成证据；
 * - 落盘原子（临时文件+rename）、有备份（`.bak`）、按 mission/task 分文件；
 * - 只存收据字段，不存任何模型自述文本。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";
import { evaluateCompletionReceipt } from "./completion-receipt.js";
import type { CompletionReceipt } from "./completion-receipt.js";

/** 收据文件内容（带 schema 版本，便于后续演进）。 */
export interface StoredCompletionReceipt {
  readonly schemaVersion: 1;
  readonly receipt: CompletionReceipt;
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class CompletionReceiptStore {
  private readonly directoryPath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "completion-receipts");
  }

  private receiptFilePath(missionIdentifier: string, taskIdentifier: string): string {
    return path.join(
      this.directoryPath,
      sanitizePathSegment(missionIdentifier),
      `${sanitizePathSegment(taskIdentifier)}.json`,
    );
  }

  /**
   * 写入收据。
   *
   * 返回值 `didWrite`：首次写入 true；同内容重复写入 false（幂等）。
   */
  async save(receipt: CompletionReceipt): Promise<{ readonly didWrite: boolean }> {
    const evaluation = evaluateCompletionReceipt({
      receipt,
      requiresCompletionControlEvent: false,
    });
    if (!evaluation.isSufficient) {
      throw new DomainError(
        "invalid-task-chain",
        `完成收据不足，拒绝落盘: ${evaluation.reasons.join("；")}`,
      );
    }
    if (receipt.missionIdentifier.trim() === "" || receipt.taskIdentifier.trim() === "") {
      throw new DomainError(
        "invalid-task-chain",
        "完成收据必须绑定 mission 与 task 标识。",
      );
    }
    return await this.writeLock.runExclusive(async () => {
      const existing = await this.read(
        receipt.missionIdentifier,
        receipt.taskIdentifier,
      );
      if (existing !== null) {
        const isSameContent =
          JSON.stringify(existing) === JSON.stringify(receipt);
        if (!isSameContent) {
          throw new DomainError(
            "journal-corrupted",
            `同一 mission/task 已有不同内容的完成收据，拒绝覆盖: ${receipt.missionIdentifier}/${receipt.taskIdentifier}`,
          );
        }
        return { didWrite: false };
      }
      const filePath = this.receiptFilePath(
        receipt.missionIdentifier,
        receipt.taskIdentifier,
      );
      await writeAtomicJson(filePath, {
        schemaVersion: 1,
        receipt,
      } satisfies StoredCompletionReceipt);
      return { didWrite: true };
    });
  }

  async read(
    missionIdentifier: string,
    taskIdentifier: string,
  ): Promise<CompletionReceipt | null> {
    const filePath = this.receiptFilePath(missionIdentifier, taskIdentifier);
    const readResult = await readJsonWithBackupRecovery(filePath, `${filePath}.bak`);
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as Partial<StoredCompletionReceipt> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      content.schemaVersion !== 1 ||
      content.receipt === undefined ||
      content.receipt === null
    ) {
      return null;
    }
    return content.receipt as CompletionReceipt;
  }

  /** 列出某 mission 下已落盘的收据（按 task 标识排序；无目录 ⇒ 空）。 */
  async listForMission(missionIdentifier: string): Promise<CompletionReceipt[]> {
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
    const receipts: CompletionReceipt[] = [];
    for (const fileName of fileNames.filter((name) => name.endsWith(".json")).sort()) {
      const taskIdentifier = fileName.slice(0, -".json".length);
      const receipt = await this.read(missionIdentifier, taskIdentifier);
      if (receipt !== null) {
        receipts.push(receipt);
      }
    }
    return receipts;
  }
}
