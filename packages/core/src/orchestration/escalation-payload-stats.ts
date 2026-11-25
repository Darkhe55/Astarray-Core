/**
 * COORD-05 05-06 补口（2026-11-25）：**真实请求体/文档读取的统计采集端**。
 *
 * 卡内要求："工具结果和通知只携带必要摘要、稳定引用及变更版本……记录每层注入量、
 * 未变版本重复读取、产生有效证据或解除阻塞的回访，以及跨层次数。缓存命中率单项不能作为通过证据。"
 *
 * 本模块只做**度量与记账**（不抓取正文内容、不写盘）：
 * - 注入量：对**实际要注入的 payload** 取字节数，按字符/4 估算 token（无 tokenizer，标记估算）；
 * - 文档读取：按内容长度度量，并复用 `EscalationObservationLedger` 判定"未变版本重复读取"；
 * - 不记录 payload 正文（只记录长度/字段数），避免观测本身泄漏内容。
 */
import type { EscalationObservationLedger } from "./escalation-context-observation.js";

export interface EscalationPayloadStats {
  readonly byteLength: number;
  readonly estimatedTokens: number;
  readonly isTokenEstimate: true;
  readonly topLevelFieldCount: number;
}

function countTopLevelFields(payload: unknown): number {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return 0;
  return Object.keys(payload as Record<string, unknown>).length;
}

/** 度量将要注入的 payload（序列化后取字节数；不保留正文）。 */
export function measureEscalationPayload(payload: unknown): EscalationPayloadStats {
  const serialized = JSON.stringify(payload) ?? "null";
  const byteLength = Buffer.byteLength(serialized, "utf8");
  return {
    byteLength,
    estimatedTokens: Math.max(1, Math.ceil(serialized.length / 4)),
    isTokenEstimate: true,
    topLevelFieldCount: countTopLevelFields(payload),
  };
}

/** 把一次层注入计入账本，并返回这次注入的度量（供调用方记录/断言）。 */
export function recordLayerInjectionFromPayload(input: {
  readonly ledger: EscalationObservationLedger;
  readonly layer: string;
  readonly payload: unknown;
}): EscalationPayloadStats {
  const stats = measureEscalationPayload(input.payload);
  input.ledger.recordLayerInjection({ layer: input.layer, tokenCount: stats.estimatedTokens });
  return stats;
}

export interface EscalationDocumentReadStats {
  readonly byteLength: number;
  readonly estimatedTokens: number;
  readonly isTokenEstimate: true;
  readonly isRepeatedUnchangedRead: boolean;
}

/** 按**真实读取到的内容**度量并记账（重复读取按 个体×文档×revision 判定）。 */
export function recordDocumentReadFromContent(input: {
  readonly ledger: EscalationObservationLedger;
  readonly agentInstanceId: string;
  readonly documentIdentifier: string;
  readonly revision: number;
  readonly content: string;
  readonly producedEvidence?: boolean;
  readonly unblockedStep?: boolean;
}): EscalationDocumentReadStats {
  const result = input.ledger.recordDocumentRead({
    agentInstanceId: input.agentInstanceId,
    documentIdentifier: input.documentIdentifier,
    revision: input.revision,
    ...(input.producedEvidence === undefined
      ? {}
      : { producedEvidence: input.producedEvidence }),
    ...(input.unblockedStep === undefined ? {} : { unblockedStep: input.unblockedStep }),
  });
  const byteLength = Buffer.byteLength(input.content, "utf8");
  return {
    byteLength,
    estimatedTokens: Math.max(1, Math.ceil(input.content.length / 4)),
    isTokenEstimate: true,
    isRepeatedUnchangedRead: result.isRepeatedUnchangedRead,
  };
}
