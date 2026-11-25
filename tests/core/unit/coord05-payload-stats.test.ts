/**
 * COORD-05 05-06 补口（2026-11-25）：请求体/文档读取统计采集端的反例。
 */
import { describe, expect, it } from "vitest";

import { EscalationObservationLedger } from "../../../packages/core/src/orchestration/escalation-context-observation.js";
import {
  measureEscalationPayload,
  recordDocumentReadFromContent,
  recordLayerInjectionFromPayload,
} from "../../../packages/core/src/orchestration/escalation-payload-stats.js";

describe("COORD-05 05-06 真实请求体统计", () => {
  it("① 注入量按实际 payload 度量（字节 + 保守 token 估算 + 字段数）", () => {
    const payload = { decisionSummary: "同意", documentReferences: [{ id: "doc-1", revision: 3 }] };
    const stats = measureEscalationPayload(payload);
    expect(stats.byteLength).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
    expect(stats.isTokenEstimate).toBe(true);
    expect(stats.topLevelFieldCount).toBe(2);
    expect(stats.estimatedTokens).toBeGreaterThan(0);
  });

  it("② 层注入计入账本：账本 token 数 = 估算值累加", () => {
    const ledger = new EscalationObservationLedger();
    const first = recordLayerInjectionFromPayload({
      ledger,
      layer: "worker",
      payload: { question: "是否继续？" },
    });
    const second = recordLayerInjectionFromPayload({
      ledger,
      layer: "worker",
      payload: { question: "第二步" },
    });
    expect(ledger.snapshot().injectedTokenCountByLayer["worker"]).toBe(
      first.estimatedTokens + second.estimatedTokens,
    );
  });

  it("③ 文档读取按真实内容度量；同个体同文档同 revision 记为重复", () => {
    const ledger = new EscalationObservationLedger();
    const firstRead = recordDocumentReadFromContent({
      ledger,
      agentInstanceId: "agent-1",
      documentIdentifier: "doc-1",
      revision: 2,
      content: "正文内容",
      producedEvidence: true,
    });
    expect(firstRead.isRepeatedUnchangedRead).toBe(false);
    const secondRead = recordDocumentReadFromContent({
      ledger,
      agentInstanceId: "agent-1",
      documentIdentifier: "doc-1",
      revision: 2,
      content: "正文内容",
    });
    expect(secondRead.isRepeatedUnchangedRead).toBe(true);
    const snapshot = ledger.snapshot();
    expect(snapshot.repeatedUnchangedReadCount).toBe(1);
    expect(snapshot.evidenceReadCount).toBe(1);
  });

  it("④ 换 revision 或换个体的读取不算重复", () => {
    const ledger = new EscalationObservationLedger();
    recordDocumentReadFromContent({
      ledger,
      agentInstanceId: "agent-1",
      documentIdentifier: "doc-1",
      revision: 1,
      content: "a",
    });
    const newRevision = recordDocumentReadFromContent({
      ledger,
      agentInstanceId: "agent-1",
      documentIdentifier: "doc-1",
      revision: 2,
      content: "b",
    });
    const otherAgent = recordDocumentReadFromContent({
      ledger,
      agentInstanceId: "agent-2",
      documentIdentifier: "doc-1",
      revision: 2,
      content: "b",
    });
    expect(newRevision.isRepeatedUnchangedRead).toBe(false);
    expect(otherAgent.isRepeatedUnchangedRead).toBe(false);
  });

  it("⑤ 观测不保留正文：账本快照只含身份/revision/标记", () => {
    const ledger = new EscalationObservationLedger();
    recordDocumentReadFromContent({
      ledger,
      agentInstanceId: "agent-1",
      documentIdentifier: "doc-1",
      revision: 1,
      content: "secret-token-abcdef",
    });
    const serialized = JSON.stringify(ledger.snapshot());
    expect(serialized).not.toContain("secret-token-abcdef");
  });

  it("⑥ 空/非对象 payload 也能度量（不抛错）", () => {
    expect(measureEscalationPayload(null).byteLength).toBeGreaterThan(0);
    expect(measureEscalationPayload([]).topLevelFieldCount).toBe(0);
    expect(() => measureEscalationPayload(undefined)).not.toThrow();
  });
});
