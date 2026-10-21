/**
 * ACCURACY-01 对账反例（2026-10-21）：**畸形证据不得让验收器崩溃**。
 *
 * 背景（我实测发现的缺口）：`TaskAccuracyVerifier` 对 `contentHash` 的判断是
 * `contentHash === null || contentHash.trim() === ""`；当调用方漏传该字段（`undefined`）时
 * **直接 TypeError**，而正确行为应是「按空证据拒绝并给出原因」。
 *
 * 卡内要求"空证据"可核查、且失败要如实说明 ⇒ 崩溃不是可接受的失败方式。
 */
import { describe, expect, it } from "vitest";

import {
  TaskAccuracyVerifier,
  type AccuracyVerifierPorts,
  type CompletionDeclaration,
  type EvidenceReference,
} from "../../../packages/core/src/orchestration/task-accuracy-verifier.js";

const requiredEntries = [
  { entryIdentifier: "entry-1", description: "必需条目 1", isRequired: true, evidenceRequirement: "artifact" as const },
  { entryIdentifier: "entry-2", description: "必需条目 2", isRequired: true, evidenceRequirement: "artifact" as const },
];

function buildPorts(overrides: Partial<AccuracyVerifierPorts> = {}): AccuracyVerifierPorts {
  const processed = new Map();
  return {
    getCurrentTaskSequenceRevision: async () => 3,
    getRequiredAcceptanceEntries: async () => requiredEntries,
    // 产物 revision 由 contentHash 的前缀区分（真实契约里 EvidenceReference 没有 artifactIdentifier 字段）
    getArtifactRevision: async (evidence) =>
      typeof evidence.contentHash === "string" && evidence.contentHash.startsWith("sha256:stale") ? 1 : 3,
    getExpectedRecipientIdentifier: async () => "main-agent-1",
    getTier: async () => "standard",
    isClarificationRequired: async () => false,
    findProcessedAttempt: async (attemptId) => processed.get(attemptId) ?? null,
    recordProcessedAttempt: async (attemptId, result) => {
      processed.set(attemptId, result);
    },
    ...overrides,
  };
}

function declaration(evidenceReferences: unknown[]): CompletionDeclaration {
  return {
    taskIdentifier: "task-1",
    completionAttemptId: "attempt-1",
    taskSequenceRevision: 3,
    completedEntryIdentifiers: ["entry-1", "entry-2"],
    evidenceReferences: evidenceReferences as EvidenceReference[],
    understandingConfirmation: null,
    deliveredToRecipientIdentifier: "main-agent-1",
  };
}

const validEvidence: EvidenceReference = {
  evidenceIdentifier: "evidence-1",
  entryIdentifier: "entry-1",
  evidenceKind: "test-report",
  contentHash: "sha256:abc",
  producedAtRevision: 3,
  producedByAgentInstanceId: "agent-1",
  observedAtIso: "2026-10-21T12:00:00.000Z",
};

describe("ACCURACY-01 验收器健壮性（对账发现）", () => {
  it("① 合法证据 ⇒ accepted（基线，确认前置条件成立）", async () => {
    const verifier = new TaskAccuracyVerifier(buildPorts());
    const result = await verifier.verifyCompletion(declaration([validEvidence]));
    expect(result.verdict).toBe("accepted");
  });

  it("② 漏传 contentHash ⇒ 不得抛错，必须按空证据 rejected 并列为 forged", async () => {
    const verifier = new TaskAccuracyVerifier(buildPorts());
    const malformedEvidence = { ...validEvidence, contentHash: undefined };
    const result = await verifier.verifyCompletion(declaration([malformedEvidence]));
    expect(result.verdict).toBe("rejected");
    expect(result.forgedEvidenceIdentifiers).toContain(validEvidence.evidenceIdentifier);
  });

  it("③ contentHash 为空串 ⇒ rejected（原有行为，不能被加固改坏）", async () => {
    const verifier = new TaskAccuracyVerifier(buildPorts());
    const result = await verifier.verifyCompletion(
      declaration([{ ...validEvidence, contentHash: "   " }]),
    );
    expect(result.verdict).toBe("rejected");
    expect(result.forgedEvidenceIdentifiers).toContain(validEvidence.evidenceIdentifier);
  });

  it("④ model-claim 允许 contentHash 为 null（不因加固而误伤）", async () => {
    const verifier = new TaskAccuracyVerifier(buildPorts());
    const result = await verifier.verifyCompletion(
      declaration([{ ...validEvidence, evidenceKind: "model-claim", contentHash: null }]),
    );
    // model-claim 不足以证明 required 条目覆盖 ⇒ 允许 rejected，但**不得**因为 hash 判为 forged
    expect(result.forgedEvidenceIdentifiers).not.toContain(validEvidence.evidenceIdentifier);
  });

  it("⑤ 幂等签收：同 completionAttemptId 再提交 ⇒ isIdempotentReplay=true 且结论一致", async () => {
    const verifier = new TaskAccuracyVerifier(buildPorts());
    const first = await verifier.verifyCompletion(declaration([validEvidence]));
    const replay = await verifier.verifyCompletion(declaration([validEvidence]));
    expect(replay.isIdempotentReplay).toBe(true);
    expect(replay.verdict).toBe(first.verdict);
  });

  it("⑥ 未来 revision ⇒ 不得 accepted（reasons 含 future-revision）", async () => {
    const verifier = new TaskAccuracyVerifier(buildPorts());
    const result = await verifier.verifyCompletion({
      ...declaration([validEvidence]),
      completionAttemptId: "attempt-future",
      taskSequenceRevision: 99,
    });
    expect(result.verdict).not.toBe("accepted");
    expect(result.reasons.some((reason) => reason.includes("future-revision"))).toBe(true);
  });
});

