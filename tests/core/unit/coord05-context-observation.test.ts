/**
 * COORD-05 05-06（2026-11-22）：上下文与观测。
 *
 * 覆盖：工具结果/通知只带引用（不复制全文）、按需回访的重复读取判定、
 * 注入量与回访统计、以及非法输入拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  EscalationObservationLedger,
  buildEscalationToolResult,
  buildStepNotification,
} from "../../../packages/core/src/orchestration/escalation-context-observation.js";
import type { EscalationRecord } from "../../../packages/core/src/orchestration/escalation-contract.js";

/** 一份"历史全文"哨兵：任何投影里出现它都说明复制了正文。 */
const DOCUMENT_BODY_SENTINEL = "全文正文哨兵：".repeat(200);

function record(): EscalationRecord {
  return {
    requestIdentifier: "escalation-1",
    originalInitiatorAgentInstanceId: "w1",
    projectIdentifier: "p1",
    missionIdentifier: "m-1",
    taskIdentifier: "T-1",
    affectedStepIdentifiers: ["step-export"],
    questionSummary: "导出方式已确认：方案 A",
    documentReferences: [
      { documentIdentifier: "docs/spec.md", revision: 3 },
      { documentIdentifier: "docs/decisions.md", revision: 7 },
    ],
    currentHandlerAgentInstanceId: null,
    version: 2,
    state: "resolved-by-agent",
    dispositions: [],
  };
}

describe("COORD-05 05-06：上下文与观测", () => {
  it("① 工具结果是引用投影：不含正文，仅摘要+引用+版本", () => {
    const result = buildEscalationToolResult(record());
    expect(result).toEqual({
      escalationRequestIdentifier: "escalation-1",
      decisionSummary: "导出方式已确认：方案 A",
      state: "resolved-by-agent",
      affectedStepIdentifiers: ["step-export"],
      documentReferences: [
        { documentIdentifier: "docs/spec.md", revision: 3 },
        { documentIdentifier: "docs/decisions.md", revision: 7 },
      ],
      readOnlyNotice: expect.stringContaining("按需读取"),
    });
    expect(JSON.stringify(result)).not.toContain(DOCUMENT_BODY_SENTINEL);
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
  });

  it("② 通知只发给受影响步骤，且只带引用", () => {
    const notification = buildStepNotification({
      escalationRequestIdentifier: "escalation-1",
      stepIdentifiers: ["step-export"],
      documentReferences: record().documentReferences,
    });
    expect(notification.stepIdentifiers).toEqual(["step-export"]);
    expect(notification.documentReferences).toEqual([
      { documentIdentifier: "docs/spec.md", revision: 3 },
      { documentIdentifier: "docs/decisions.md", revision: 7 },
    ]);
    expect(JSON.stringify(notification)).not.toContain(DOCUMENT_BODY_SENTINEL);
  });

  it("③ 未变版本重复读取：同个体同文档同 revision 才算重复", () => {
    const ledger = new EscalationObservationLedger();
    expect(
      ledger.recordDocumentRead({
        agentInstanceId: "w1",
        documentIdentifier: "docs/spec.md",
        revision: 3,
      }),
    ).toEqual({ isRepeatedUnchangedRead: false });
    expect(
      ledger.recordDocumentRead({
        agentInstanceId: "w1",
        documentIdentifier: "docs/spec.md",
        revision: 3,
      }),
    ).toEqual({ isRepeatedUnchangedRead: true });
    /** 换 revision ⇒ 不是重复。 */
    expect(
      ledger.recordDocumentRead({
        agentInstanceId: "w1",
        documentIdentifier: "docs/spec.md",
        revision: 4,
      }),
    ).toEqual({ isRepeatedUnchangedRead: false });
    /** 换个体 ⇒ 不是重复。 */
    expect(
      ledger.recordDocumentRead({
        agentInstanceId: "w2",
        documentIdentifier: "docs/spec.md",
        revision: 3,
      }),
    ).toEqual({ isRepeatedUnchangedRead: false });
    expect(ledger.snapshot().repeatedUnchangedReadCount).toBe(1);
  });

  it("④ 注入量/有效证据/解除阻塞/跨层数进入快照", () => {
    const ledger = new EscalationObservationLedger();
    ledger.recordLayerInjection({ layer: "worker", tokenCount: 120 });
    ledger.recordLayerInjection({ layer: "worker", tokenCount: 30 });
    ledger.recordLayerInjection({ layer: "main", tokenCount: 80 });
    ledger.recordDocumentRead({
      agentInstanceId: "w1",
      documentIdentifier: "docs/spec.md",
      revision: 3,
      producedEvidence: true,
    });
    ledger.recordDocumentRead({
      agentInstanceId: "s1",
      documentIdentifier: "docs/decisions.md",
      revision: 7,
      unblockedStep: true,
    });
    ledger.recordCrossLayerHop();
    ledger.recordCrossLayerHop();
    const snapshot = ledger.snapshot();
    expect(snapshot.injectedTokenCountByLayer).toEqual({ worker: 150, main: 80 });
    expect(snapshot.evidenceReadCount).toBe(1);
    expect(snapshot.unblockedReadCount).toBe(1);
    expect(snapshot.crossLayerHopCount).toBe(2);
    expect(snapshot.documentReads).toHaveLength(2);
  });

  it("⑤ 非法输入 ⇒ 拒绝（不记假账）", () => {
    const ledger = new EscalationObservationLedger();
    expect(() => ledger.recordLayerInjection({ layer: "w", tokenCount: -1 })).toThrow(/非负整数/);
    expect(() =>
      ledger.recordDocumentRead({
        agentInstanceId: "w1",
        documentIdentifier: "",
        revision: 1,
      }),
    ).toThrow(/非空标识/);
    expect(() =>
      ledger.recordDocumentRead({
        agentInstanceId: "w1",
        documentIdentifier: "docs/a.md",
        revision: -1,
      }),
    ).toThrow(/非空标识/);
  });
});
