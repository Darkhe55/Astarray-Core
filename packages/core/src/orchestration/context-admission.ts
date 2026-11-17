/**
 * COORD-01-03（卡 §5）：**上下文准入**。
 *
 * 卡内要点：
 * - 控制器只把**确需模型处理**的内容放入既有安全点/上下文准入接口，**不整包复制**反馈日志；
 * - 普通报告（information 类）只归档，**不隐式启动续跑**、不自动唤醒主 Agent；
 * - 幂等应用状态与**上下文注入回执分开维护**（本模块只记准入/投递回执，绝不写应用状态）。
 *
 * 2026-11-16 修正（审查报告 P1）：**准入 ≠ 投递**。
 * 旧实现 `admit()` 只写消息 ID/接收者/时间就返回 `injected`，调用方据此把 journal 写成 `delivered`，
 * 但消息正文从未进入任何模型请求——"已投递"是假的。
 * 现在拆成两个动作：
 * 1. `admit()`：只记**准入**（这一类消息需要模型处理），**恒不声称已投递**；
 * 2. `recordDelivered()`：只有在**某次真实模型请求已携带该消息正文**之后才能调用，
 *    并必须给出 `requestIdentifier` 作为证据。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export type ContextAdmissionClass = "requires-model-decision" | "archive-only";

export interface ContextInjectionReceipt {
  readonly messageIdentifier: string;
  readonly recipientIdentifier: string;
  readonly admissionClass: ContextAdmissionClass;
  readonly admittedAtIso: string;
  /** 注入**不等于**要求模型续跑：此处固定 false，续跑必须由调度决定。 */
  readonly isResumeRequested: false;
  /** 实际投递时间（模型请求携带该内容之后才非 null）。 */
  readonly deliveredAtIso: string | null;
  /** 携带该内容的请求标识（投递证据；未投递为 null）。 */
  readonly deliveryRequestIdentifier: string | null;
  /**
   * WIRING-04-02：**载荷指纹**——这次请求实际携带的内容指纹。
   *
   * 只证明"带上了这份内容"，不证明模型理解；未投递为 null。
   */
  readonly payloadFingerprint?: string | null;
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
  return partitionKey.replace(/[^A-Za-z0-9._-]/gu, "_");
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
   * 记录**准入**（不改口头承诺"已投递"）。
   *
   * - `archive-only` ⇒ 只归档（不进入任何上下文队列）；
   * - 需要模型决策 ⇒ 记一条准入回执；重复准入只记一次。
   */
  async admit(input: {
    partitionKey: string;
    recipientIdentifier: string;
    messageIdentifier: string;
    admissionClass: ContextAdmissionClass;
  }): Promise<{
    outcome: "admitted" | "archive-only" | "duplicate-admission-ignored";
    isAdmitted: boolean;
    /** 准入阶段恒为 false：投递要等真实模型请求携带该内容。 */
    isDelivered: false;
    isResumeRequested: false;
  }> {
    if (input.admissionClass === "archive-only") {
      return {
        outcome: "archive-only",
        isAdmitted: false,
        isDelivered: false,
        isResumeRequested: false,
      };
    }
    const document = await this.loadDocument(input.partitionKey);
    if (document.receipts.some((receipt) => receipt.messageIdentifier === input.messageIdentifier)) {
      return {
        outcome: "duplicate-admission-ignored",
        isAdmitted: false,
        isDelivered: false,
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
          admissionClass: input.admissionClass,
          admittedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
          isResumeRequested: false,
          deliveredAtIso: null,
          deliveryRequestIdentifier: null,
        },
      ],
    });
    return {
      outcome: "admitted",
      isAdmitted: true,
      isDelivered: false,
      isResumeRequested: false,
    };
  }

  /**
   * 记录**实际投递**：必须在某次模型请求确实携带该消息正文之后调用。
   *
   * `requestIdentifier` 是证据：没有它就无法区分"真的带上了"与"只是记了账"。
   */
  async recordDelivered(input: {
    partitionKey: string;
    messageIdentifier: string;
    requestIdentifier: string;
    deliveredAtIso?: string;
    /** WIRING-04-02：本次请求实际携带内容的指纹（缺省不改旧行为）。 */
    payloadFingerprint?: string;
  }): Promise<{
    outcome: "delivered" | "not-admitted" | "already-delivered";
    receipt: ContextInjectionReceipt | null;
  }> {
    if (input.requestIdentifier.trim() === "") {
      throw new Error("记录投递必须给出 requestIdentifier（投递证据不可缺失）");
    }
    const document = await this.loadDocument(input.partitionKey);
    const target = document.receipts.find(
      (receipt) => receipt.messageIdentifier === input.messageIdentifier,
    );
    if (target === undefined) {
      return { outcome: "not-admitted", receipt: null };
    }
    if (target.deliveredAtIso !== null) {
      return { outcome: "already-delivered", receipt: target };
    }
    const deliveredReceipt: ContextInjectionReceipt = {
      ...target,
      deliveredAtIso: input.deliveredAtIso ?? new Date(this.nowUnixMilliseconds()).toISOString(),
      deliveryRequestIdentifier: input.requestIdentifier,
      ...(input.payloadFingerprint === undefined
        ? {}
        : { payloadFingerprint: input.payloadFingerprint }),
    };
    await this.saveDocument({
      ...document,
      receipts: document.receipts.map((receipt) =>
        receipt.messageIdentifier === input.messageIdentifier ? deliveredReceipt : receipt,
      ),
    });
    return { outcome: "delivered", receipt: deliveredReceipt };
  }

  /** 只读查询：该消息的准入/投递回执（与 journal 的应用状态互相独立）。 */
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
