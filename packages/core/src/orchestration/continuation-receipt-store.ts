/**
 * RESUME-02（2026-11-24）：恢复意图回执的**持久化仓库**。
 *
 * - 按 `requestIdentifier` 去重：同一请求重复登记返回**同一回执**（不延长有效期）；
 * - 读取时清理过期回执（5 分钟窗口很短，过期即无价值）；
 * - 文件损坏 ⇒ 视为**没有回执**（fail-closed：宁可要求重新确认，不信任坏数据）；
 * - 仓库只存"用户确认恢复某任务"的证据，**不含**任何工具/外发/安装授权。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  issueResumeIntentReceipt,
  validateResumeIntentReceipt,
  type ResumeIntentReceipt,
  type StructuredContinuationRequest,
} from "./continuation-request.js";

export const RESUME_INTENT_STORE_SCHEMA_VERSION = 1;

export interface ResumeIntentStoreDocument {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly receipts: readonly ResumeIntentReceipt[];
}

export class ResumeIntentReceiptStore {
  private readonly filePath: string;

  constructor(private readonly options: { readonly baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "resume-intent", "receipts.json");
  }

  private async readDocument(): Promise<ResumeIntentStoreDocument> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<ResumeIntentStoreDocument>;
      if (!Array.isArray(parsed.receipts)) {
        return { schemaVersion: RESUME_INTENT_STORE_SCHEMA_VERSION, revision: 0, receipts: [] };
      }
      return {
        schemaVersion: parsed.schemaVersion ?? RESUME_INTENT_STORE_SCHEMA_VERSION,
        revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        receipts: parsed.receipts as ResumeIntentReceipt[],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { schemaVersion: RESUME_INTENT_STORE_SCHEMA_VERSION, revision: 0, receipts: [] };
      }
      /** 损坏/不可读 ⇒ 不信任其中的回执（fail-closed），后续登记会重写为新文档。 */
      return { schemaVersion: RESUME_INTENT_STORE_SCHEMA_VERSION, revision: 0, receipts: [] };
    }
  }

  private async writeDocument(document: ResumeIntentStoreDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
  }

  private isExpired(receipt: ResumeIntentReceipt, nowIso: string): boolean {
    const nowMilliseconds = Date.parse(nowIso);
    if (Number.isNaN(nowMilliseconds)) {
      return true;
    }
    return nowMilliseconds >= Date.parse(receipt.expiresAtIso);
  }

  /** 登记（幂等）。返回回执与"是否复用已有登记"。 */
  async issue(input: {
    readonly receiptIdentifier: string;
    readonly request: StructuredContinuationRequest;
    readonly principalIdentifier: string;
    readonly sourceChannel: string;
    readonly nowIso: string;
  }): Promise<{ readonly receipt: ResumeIntentReceipt; readonly isDuplicate: boolean }> {
    const document = await this.readDocument();
    const activeReceipts = document.receipts.filter(
      (receipt) => !this.isExpired(receipt, input.nowIso),
    );
    const existing = activeReceipts.find(
      (receipt) => receipt.requestIdentifier === input.request.requestIdentifier,
    );
    if (existing !== undefined) {
      if (activeReceipts.length !== document.receipts.length) {
        await this.writeDocument({ ...document, revision: document.revision + 1, receipts: activeReceipts });
      }
      return { receipt: existing, isDuplicate: true };
    }
    const receipt = issueResumeIntentReceipt({
      receiptIdentifier: input.receiptIdentifier,
      request: input.request,
      principalIdentifier: input.principalIdentifier,
      sourceChannel: input.sourceChannel,
      nowIso: input.nowIso,
    });
    await this.writeDocument({
      ...document,
      revision: document.revision + 1,
      receipts: [...activeReceipts, receipt],
    });
    return { receipt, isDuplicate: false };
  }

  /** 查找并复核（过期/主体/目标/版本任一不符即返回 null 与原因码）。 */
  async findValid(input: {
    readonly requestIdentifier: string;
    readonly principalIdentifier: string;
    readonly taskIdentifier: string;
    readonly expectedRevision: number;
    readonly nowIso: string;
  }): Promise<{ readonly receipt: ResumeIntentReceipt | null; readonly reasonCode: string | null }> {
    const document = await this.readDocument();
    const receipt = document.receipts.find(
      (candidate) => candidate.requestIdentifier === input.requestIdentifier,
    );
    if (receipt === undefined) {
      return { receipt: null, reasonCode: "receipt-not-found" };
    }
    const validation = validateResumeIntentReceipt({
      receipt,
      principalIdentifier: input.principalIdentifier,
      taskIdentifier: input.taskIdentifier,
      expectedRevision: input.expectedRevision,
      nowIso: input.nowIso,
    });
    if (!validation.isValid) {
      return { receipt: null, reasonCode: validation.reasonCode };
    }
    return { receipt, reasonCode: null };
  }

  /** 清理过期回执（返回清理数量；供定期维护/重启调用）。 */
  async pruneExpired(nowIso: string): Promise<number> {
    const document = await this.readDocument();
    const activeReceipts = document.receipts.filter(
      (receipt) => !this.isExpired(receipt, nowIso),
    );
    const removedCount = document.receipts.length - activeReceipts.length;
    if (removedCount > 0) {
      await this.writeDocument({
        ...document,
        revision: document.revision + 1,
        receipts: activeReceipts,
      });
    }
    return removedCount;
  }

  async count(nowIso: string): Promise<number> {
    return (await this.readDocument()).receipts.filter(
      (receipt) => !this.isExpired(receipt, nowIso),
    ).length;
  }
}
