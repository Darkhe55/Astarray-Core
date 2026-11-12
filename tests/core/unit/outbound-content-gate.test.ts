/**
 * 通用外发门禁（此前 `tests/` 零引用）：纯判定，**默认拒绝**。
 *
 * 四条硬约束逐条锁死：缺任一绑定字段即阻断；扫描未完成/有命中也阻断；
 * 脱敏改变内容 ⇒ 旧授权失效必须重新授权；导出元数据必须与实际内容一致。
 */
import { describe, expect, it } from "vitest";

import {
  computeOutboundContentHash,
  evaluateOutboundContentGate,
} from "../../../packages/core/src/tools/outbound-content-gate.js";
import type {
  OutboundContentCandidate,
  OutboundAuthorizationBinding,
} from "../../../packages/core/src/tools/outbound-content-gate.js";
import type { SensitiveScanResult } from "../../../packages/core/src/tools/sensitive-content-scan-contract.js";

const CONTENT = "报告正文：没有敏感信息";

function buildScanResult(overrides: Partial<SensitiveScanResult> = {}): SensitiveScanResult {
  const byteCount = Buffer.byteLength(CONTENT, "utf8");
  return {
    outcome: "clean",
    ruleSetVersion: 1,
    scannedByteCount: byteCount,
    totalByteCount: byteCount,
    unit: "utf8-bytes",
    limitReason: null,
    matchedRuleIdentifiers: [],
    isTruncated: false,
    isClean: true,
    ...overrides,
  } as SensitiveScanResult;
}

function buildAuthorization(
  overrides: Partial<OutboundAuthorizationBinding> = {},
): OutboundAuthorizationBinding {
  return {
    sourceProjectIdentifier: "project-alpha",
    approvedContentRevision: 1,
    approvedContentHash: computeOutboundContentHash(CONTENT),
    authorizationScope: "read-only-report",
    targetAccountIdentifier: "account-1",
    targetDeviceIdentifier: null,
    ruleSetVersion: 1,
    ...overrides,
  };
}

function buildCandidate(overrides: Partial<OutboundContentCandidate> = {}): OutboundContentCandidate {
  return {
    sourceProjectIdentifier: "project-alpha",
    contentRevision: 1,
    content: CONTENT,
    scanResult: buildScanResult(),
    didRedactionChangeContent: false,
    preRedactionContentHash: null,
    authorization: buildAuthorization(),
    authenticatedUserId: "user-1",
    targetAccountIdentifier: "account-1",
    targetDeviceIdentifier: null,
    exportMetadata: {
      contentHash: computeOutboundContentHash(CONTENT),
      contentRevision: 1,
      targetAccountIdentifier: "account-1",
      targetDeviceIdentifier: null,
    },
    ...overrides,
  } as OutboundContentCandidate;
}

function reasonCodesOf(candidate: OutboundContentCandidate): readonly string[] {
  const decision = evaluateOutboundContentGate(candidate);
  return decision.isAllowed ? [] : decision.reasonCodes;
}

describe("外发门禁：默认拒绝", () => {
  it("① 缺任一绑定字段 ⇒ 阻断并逐条给出原因", () => {
    expect(reasonCodesOf(buildCandidate({ authenticatedUserId: null }))).toContain("not-authenticated");
    expect(reasonCodesOf(buildCandidate({ authenticatedUserId: "   " }))).toContain("not-authenticated");
    expect(reasonCodesOf(buildCandidate({ sourceProjectIdentifier: "" }))).toContain(
      "missing-source-project",
    );
    expect(reasonCodesOf(buildCandidate({ contentRevision: 0 }))).toContain("missing-content-revision");
    expect(reasonCodesOf(buildCandidate({ targetAccountIdentifier: " " }))).toContain(
      "missing-target-account",
    );
  });

  it("② 没有授权绑定 ⇒ reauthorization-required", () => {
    const decision = evaluateOutboundContentGate(buildCandidate({ authorization: null }));
    expect(decision.isAllowed).toBe(false);
    if (decision.isAllowed) throw new Error("unreachable");
    expect(decision.reasonCodes).toContain("reauthorization-required");
  });
});

describe("外发门禁：扫描结论", () => {
  it("③ 扫描缺失 / 未完成 / 失败 / 命中 一律阻断", () => {
    expect(reasonCodesOf(buildCandidate({ scanResult: null }))).toContain("scan-not-clean");
    expect(
      reasonCodesOf(buildCandidate({ scanResult: buildScanResult({ outcome: "incomplete", isClean: false }) })),
    ).toContain("scan-incomplete");
    expect(
      reasonCodesOf(buildCandidate({ scanResult: buildScanResult({ outcome: "error", isClean: false }) })),
    ).toContain("scan-incomplete");

    const sensitiveDecision = evaluateOutboundContentGate(
      buildCandidate({
        scanResult: buildScanResult({
          outcome: "sensitive",
          isClean: false,
          matchedRuleIdentifiers: ["api-key"],
        }),
      }),
    );
    expect(sensitiveDecision.isAllowed).toBe(false);
    if (sensitiveDecision.isAllowed) throw new Error("unreachable");
    expect(sensitiveDecision.reasonCodes).toContain("scan-not-clean");
    expect(sensitiveDecision.detail).toContain("api-key");
  });

  it("④ 规则集版本与授权时不同 ⇒ rule-version-mismatch，并要求重新授权", () => {
    const decision = evaluateOutboundContentGate(
      buildCandidate({ scanResult: buildScanResult({ ruleSetVersion: 2 }) }),
    );
    expect(decision.isAllowed).toBe(false);
    if (decision.isAllowed) throw new Error("unreachable");
    expect(decision.reasonCodes).toContain("rule-version-mismatch");
    expect(decision.requiredReauthorization).toEqual({
      contentRevision: 1,
      contentHash: computeOutboundContentHash(CONTENT),
    });
  });
});

describe("外发门禁：脱敏与哈希", () => {
  it("⑤ 声明脱敏但哈希未变 ⇒ content-hash-mismatch（记录不一致）", () => {
    expect(
      reasonCodesOf(
        buildCandidate({
          didRedactionChangeContent: true,
          preRedactionContentHash: computeOutboundContentHash(CONTENT),
        }),
      ),
    ).toContain("content-hash-mismatch");
  });

  it("⑥ 脱敏改变内容 ⇒ 旧授权失效，必须带新 revision 重新授权", () => {
    const redactedContent = "报告正文：已脱敏";
    const decision = evaluateOutboundContentGate(
      buildCandidate({
        content: redactedContent,
        contentRevision: 2,
        didRedactionChangeContent: true,
        preRedactionContentHash: computeOutboundContentHash(CONTENT),
        exportMetadata: {
          contentHash: computeOutboundContentHash(redactedContent),
          contentRevision: 2,
          targetAccountIdentifier: "account-1",
          targetDeviceIdentifier: null,
        },
      }),
    );
    expect(decision.isAllowed).toBe(false);
    if (decision.isAllowed) throw new Error("unreachable");
    expect(decision.reasonCodes).toContain("reauthorization-required");
    expect(decision.requiredReauthorization).toEqual({
      contentRevision: 2,
      contentHash: computeOutboundContentHash(redactedContent),
    });
  });
});

describe("外发门禁：导出元数据一致性", () => {
  it("⑦ 导出元数据哈希与实际内容不符 ⇒ content-hash-mismatch（检查 A 后导出 B）", () => {
    expect(
      reasonCodesOf(
        buildCandidate({
          exportMetadata: {
            contentHash: computeOutboundContentHash("另一份内容"),
            contentRevision: 1,
            targetAccountIdentifier: "account-1",
            targetDeviceIdentifier: null,
          },
        }),
      ),
    ).toContain("content-hash-mismatch");
  });

  it("⑧ 导出元数据 revision / 目标账户 / 目标设备不符 ⇒ 各自原因码", () => {
    expect(
      reasonCodesOf(
        buildCandidate({
          exportMetadata: {
            contentHash: computeOutboundContentHash(CONTENT),
            contentRevision: 9,
            targetAccountIdentifier: "account-1",
            targetDeviceIdentifier: null,
          },
        }),
      ),
    ).toContain("revision-mismatch");
    expect(
      reasonCodesOf(
        buildCandidate({
          exportMetadata: {
            contentHash: computeOutboundContentHash(CONTENT),
            contentRevision: 1,
            targetAccountIdentifier: "account-other",
            targetDeviceIdentifier: null,
          },
        }),
      ),
    ).toContain("target-mismatch");
    expect(
      reasonCodesOf(
        buildCandidate({
          exportMetadata: {
            contentHash: computeOutboundContentHash(CONTENT),
            contentRevision: 1,
            targetAccountIdentifier: "account-1",
            targetDeviceIdentifier: "device-x",
          },
        }),
      ),
    ).toContain("device-unbound");
  });

  it("⑨ 授权绑定设备与本次设备不同 ⇒ device-unbound", () => {
    expect(
      reasonCodesOf(
        buildCandidate({
          authorization: buildAuthorization({ targetDeviceIdentifier: "device-a" }),
          targetDeviceIdentifier: "device-b",
          exportMetadata: {
            contentHash: computeOutboundContentHash(CONTENT),
            contentRevision: 1,
            targetAccountIdentifier: "account-1",
            targetDeviceIdentifier: "device-b",
          },
        }),
      ),
    ).toContain("device-unbound");
  });

  it("⑩ 全部满足 ⇒ 放行，并返回内容哈希与扫描规则版本", () => {
    const decision = evaluateOutboundContentGate(buildCandidate());
    expect(decision.isAllowed).toBe(true);
    if (!decision.isAllowed) throw new Error("应当放行");
    expect(decision.contentHash).toBe(computeOutboundContentHash(CONTENT));
    expect(decision.scannedRuleSetVersion).toBe(1);
  });

  it("⑪ 纯判定：相同输入结果相同；哈希稳定且带 sha256 前缀", () => {
    const first = evaluateOutboundContentGate(buildCandidate());
    const second = evaluateOutboundContentGate(buildCandidate());
    expect(first).toEqual(second);
    expect(computeOutboundContentHash(CONTENT)).toBe(computeOutboundContentHash(CONTENT));
    expect(computeOutboundContentHash(CONTENT).startsWith("sha256:")).toBe(true);
    expect(computeOutboundContentHash("a")).not.toBe(computeOutboundContentHash("b"));
  });
});
