/**
 * COORD-05 05-06（2026-11-22）：**上下文与观测**。
 *
 * 规则（卡内）：
 * - 工具结果与通知只携带**必要摘要 + 稳定引用 + 变更版本**，不复制历史全文；
 * - 材料按需回访；记录每层注入量、**未变版本的重复读取**、产生有效证据/解除阻塞的回访、
 *   以及跨层次数（复用 T09A 口径）；
 * - 缓存命中率单项不能作为通过证据：这里同时给出"是否复制全文/正文去了哪些个体"的事实。
 */
import type { EscalationRecord } from "./escalation-contract.js";

/** 工具结果的**引用投影**：只含标识与版本，不含正文。 */
export interface EscalationReferenceProjection {
  readonly escalationRequestIdentifier: string;
  readonly decisionSummary: string;
  readonly state: EscalationRecord["state"];
  readonly affectedStepIdentifiers: ReadonlyArray<string>;
  readonly documentReferences: ReadonlyArray<{
    readonly documentIdentifier: string;
    readonly revision: number;
  }>;
  readonly readOnlyNotice: string;
}

export function buildEscalationToolResult(
  record: EscalationRecord,
): EscalationReferenceProjection {
  return {
    escalationRequestIdentifier: record.requestIdentifier,
    decisionSummary: record.questionSummary,
    state: record.state,
    affectedStepIdentifiers: [...record.affectedStepIdentifiers],
    documentReferences: record.documentReferences.map((reference) => ({
      documentIdentifier: reference.documentIdentifier,
      revision: reference.revision,
    })),
    readOnlyNotice: "只读投影：仅摘要与稳定引用；需要正文请按引用与版本按需读取。",
  };
}

/** 通知投影：只发给受影响的步骤，只带引用，不带正文。 */
export function buildStepNotification(input: {
  readonly escalationRequestIdentifier: string;
  readonly stepIdentifiers: ReadonlyArray<string>;
  readonly documentReferences: EscalationRecord["documentReferences"];
}): {
  readonly escalationRequestIdentifier: string;
  readonly stepIdentifiers: ReadonlyArray<string>;
  readonly documentReferences: ReadonlyArray<{
    readonly documentIdentifier: string;
    readonly revision: number;
  }>;
  readonly notice: string;
} {
  return {
    escalationRequestIdentifier: input.escalationRequestIdentifier,
    stepIdentifiers: [...input.stepIdentifiers],
    documentReferences: input.documentReferences.map((reference) => ({
      documentIdentifier: reference.documentIdentifier,
      revision: reference.revision,
    })),
    notice: "决定已写回；按引用与版本读取正文，不随通知复制全文。",
  };
}

export interface EscalationObservationSnapshot {
  readonly injectedTokenCountByLayer: Readonly<Record<string, number>>;
  readonly repeatedUnchangedReadCount: number;
  readonly evidenceReadCount: number;
  readonly unblockedReadCount: number;
  readonly crossLayerHopCount: number;
  readonly documentReads: ReadonlyArray<{
    readonly agentInstanceId: string;
    readonly documentIdentifier: string;
    readonly revision: number;
    readonly isRepeatedUnchangedRead: boolean;
    readonly producedEvidence: boolean;
    readonly unblockedStep: boolean;
  }>;
}

/**
 * 观测账本（进程内）：记录注入量与回访事实。
 *
 * "未变版本重复读取" 按（个体, 文档, revision）判定；换个体或换 revision 都不是重复。
 */
export class EscalationObservationLedger {
  private readonly injectedTokensByLayer = new Map<string, number>();
  private readonly readKeys = new Map<string, { revision: number; count: number }>();
  private readonly reads: Array<EscalationObservationSnapshot["documentReads"][number]> = [];
  private crossLayerHops = 0;
  private repeatedUnchangedReads = 0;
  private evidenceReads = 0;
  private unblockedReads = 0;

  recordLayerInjection(input: {
    readonly layer: string;
    readonly tokenCount: number;
  }): void {
    if (!Number.isInteger(input.tokenCount) || input.tokenCount < 0) {
      throw new Error("注入量必须是非负整数。");
    }
    this.injectedTokensByLayer.set(
      input.layer,
      (this.injectedTokensByLayer.get(input.layer) ?? 0) + input.tokenCount,
    );
  }

  recordDocumentRead(input: {
    readonly agentInstanceId: string;
    readonly documentIdentifier: string;
    readonly revision: number;
    readonly producedEvidence?: boolean;
    readonly unblockedStep?: boolean;
  }): { readonly isRepeatedUnchangedRead: boolean } {
    if (input.documentIdentifier.trim() === "" || input.revision < 0) {
      throw new Error("文档读取必须带非空标识与非负 revision。");
    }
    const key = `${input.agentInstanceId}|${input.documentIdentifier}|${String(input.revision)}`;
    const existing = this.readKeys.get(key);
    const isRepeatedUnchangedRead = existing !== undefined;
    if (isRepeatedUnchangedRead) {
      this.repeatedUnchangedReads += 1;
    } else {
      this.readKeys.set(key, { revision: input.revision, count: 1 });
    }
    if (input.producedEvidence === true) {
      this.evidenceReads += 1;
    }
    if (input.unblockedStep === true) {
      this.unblockedReads += 1;
    }
    this.reads.push({
      agentInstanceId: input.agentInstanceId,
      documentIdentifier: input.documentIdentifier,
      revision: input.revision,
      isRepeatedUnchangedRead,
      producedEvidence: input.producedEvidence === true,
      unblockedStep: input.unblockedStep === true,
    });
    return { isRepeatedUnchangedRead };
  }

  recordCrossLayerHop(): void {
    this.crossLayerHops += 1;
  }

  snapshot(): EscalationObservationSnapshot {
    return {
      injectedTokenCountByLayer: Object.fromEntries(this.injectedTokensByLayer),
      repeatedUnchangedReadCount: this.repeatedUnchangedReads,
      evidenceReadCount: this.evidenceReads,
      unblockedReadCount: this.unblockedReads,
      crossLayerHopCount: this.crossLayerHops,
      documentReads: [...this.reads],
    };
  }
}
