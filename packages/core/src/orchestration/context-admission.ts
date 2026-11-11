/**
 * COORD-01-03（卡 §5）：**上下文准入**。
 *
 * 卡内要点：
 * - 控制器只把**确需模型处理**的内容放入既有安全点/上下文准入接口，**不整包复制**反馈日志；
 * - 普通报告（information 类）只归档，**不隐式启动续跑**、不自动唤醒主 Agent；
 * - 幂等应用状态与**上下文注入回执分开维护**（本模块只记注入回执，绝不写应用状态）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export type ContextAdmissionClass = "requires-model-decision" | "archive-only";

export interface ContextInjectionReceipt {
  readonly messageIdentifier: string;
  readonly recipientIdentifier: string;
  readonly admittedAtIso: string;
  /** 注入**不等于**要求模型续跑：此处固定 false，续跑必须由调度决定。 */
  readonly isResumeRequested: false;
}

interface ContextInjectionDocument {
  readonly schemaVersion: 1;
  readonly partitionKey: string;
  readonly receipts: readonly ContextInjectionReceipt[];
}

/**
 * 判定一条消息是否需要进入模型上下文。
 *
 * 判定依据是**本地可信字段**（不是模型自述）：消息类别 + 是否带未决问题 + 是否显式要求模型决策。
 * 信息类（普通进度/摘要）一律只归档。
 */
export function classifyContextAdmission(input: {
  payload: {
    kind?: string;
    unresolvedQuestions?: readonly string[];
    requiresModelDecision?: boolean;
  };
}): ContextAdmissionClass {
  if (input.payload.requiresModelDecision === true) return "requires-model-decision";
  if ((input.payload.unresolvedQuestions ?? []).length > 0) return "requires-model-decision";
  if (input.payload.kind === "clarification-request") return "requires-model-decision";
  if (input.payload.kind === "assistance-disclosure-request") return "requires-model-decision";
  return "archive-only";
}

export interface ContextAdmissionControllerOptions {
  readonly stateDirectory: string;
  readonly nowUnixMilliseconds?: () => number;
}

function sanitizeFileName(partitionKey: string): string {
  return partitionKey.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export class ContextAdmissionController {
  private readonly stateDirectory: string;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: ContextAdmissionControllerOptions) {
    this.stateDirectory = options.stateDirectory;
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
  }

  private filePathFor(partitionKey: string): string {
    return path.join(this.stateDirectory, `${sanitizeFileName(partitionKey)}.json`);
  }

  private async loadDocument(partitionKey: string): Promise<ContextInjectionDocument> {
    const primaryPath = this.filePathFor(partitionKey);
    const readResult = await readJsonWithBackupRecovery(primaryPath, `${primaryPath}.bak`);
    if (readResult === null) return { schemaVersion: 1, partitionKey, receipts: [] };
    return readResult.content as ContextInjectionDocument;
  }

  private async saveDocument(document: ContextInjectionDocument): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await writeAtomicJson(this.filePathFor(document.partitionKey), document);
  }

  /**
   * 尝试把消息放进模型上下文。
   *
   * - `archive-only` ⇒ 不进上下文、**不请求续跑**；
   * - 需要模型决策 ⇒ 注入一次并记回执；重复注入 ⇒ `duplicate-injection-ignored`。
   */
  async admit(input: {
    partitionKey: string;
    recipientIdentifier: string;
    messageIdentifier: string;
    admissionClass: ContextAdmissionClass;
  }): Promise<{
    outcome: "injected" | "archived-only" | "duplicate-injection-ignored";
    isInjected: boolean;
    isResumeRequested: false;
  }> {
    if (input.admissionClass === "archive-only") {
      return { outcome: "archived-only", isInjected: false, isResumeRequested: false };
    }
    const document = await this.loadDocument(input.partitionKey);
    if (document.receipts.some((receipt) => receipt.messageIdentifier === input.messageIdentifier)) {
      return {
        outcome: "duplicate-injection-ignored",
        isInjected: false,
        isResumeRequested: false,
      };
    }
    await this.saveDocument({
      ...document,
      receipts: [
        ...document.receipts,
        {
          messageIdentifier: input.messageIdentifier,
          recipientIdentifier: input.recipientIdentifier,
          admittedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
          isResumeRequested: false,
        },
      ],
    });
    return { outcome: "injected", isInjected: true, isResumeRequested: false };
  }

  /** 只读查询：该消息是否已注入过上下文（与 journal 的应用状态互相独立）。 */
  async readInjectionReceipt(input: {
    partitionKey: string;
    messageIdentifier: string;
  }): Promise<ContextInjectionReceipt | null> {
    const document = await this.loadDocument(input.partitionKey);
    return (
      document.receipts.find((receipt) => receipt.messageIdentifier === input.messageIdentifier) ??
      null
    );
  }
}
