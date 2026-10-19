/**
 * DIAG 证据包契约的反例（2026-10-19 R61）。
 *
 * 核心纪律：**用户主动**、**不自动联网**、**必须带窗口/版本/平台/脱敏说明**、
 * **不含原始参数或凭据**、**只允许白名单章节**。
 */
import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_EVIDENCE_PACK_SECTIONS,
  buildDiagnosticEvidencePackManifest,
  evaluateDiagnosticEvidencePackExport,
} from "../../../packages/core/src/orchestration/diagnostic-evidence-pack-contract.js";

function exportInput(overrides: Record<string, unknown> = {}) {
  return {
    isUserInitiated: true,
    isNetworkUploadRequested: false,
    windowStartIso: "2026-10-19T00:00:00.000Z",
    windowEndIso: "2026-10-19T12:00:00.000Z",
    astarrayVersion: "0.1.0",
    platform: "win32-x64",
    redactionSummary: "已移除原始命令参数、环境变量与凭据；错误文本仅保留分类与指纹。",
    sections: ["findings-summary", "coverage-window", "redaction-notes"],
    containsRawArguments: false,
    containsSecrets: false,
    ...overrides,
  };
}

describe("DIAG 证据包契约", () => {
  it("① 用户主动 + 窗口/版本/平台/脱敏齐备 + 无敏感内容 ⇒ 允许", () => {
    expect(evaluateDiagnosticEvidencePackExport(exportInput()).kind).toBe("allowed");
  });

  it("② 非用户主动 / 请求自动联网 ⇒ 拒绝（不自动生成、不自动外发）", () => {
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ isUserInitiated: false })),
    ).toMatchObject({ kind: "rejected", reasonCode: "not-user-initiated" });
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ isNetworkUploadRequested: true })),
    ).toMatchObject({ kind: "rejected", reasonCode: "auto-upload-requested" });
  });

  it("③ 缺时间窗 / 缺版本或平台 / 缺脱敏说明 ⇒ 拒绝", () => {
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ windowEndIso: null })),
    ).toMatchObject({ reasonCode: "missing-time-window" });
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ platform: "  " })),
    ).toMatchObject({ reasonCode: "missing-platform-or-version" });
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ astarrayVersion: "" })),
    ).toMatchObject({ reasonCode: "missing-platform-or-version" });
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ redactionSummary: " " })),
    ).toMatchObject({ reasonCode: "missing-redaction-summary" });
  });

  it("④ 含原始参数或凭据 ⇒ 拒绝（写入前最小化，不是事后遮盖）", () => {
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ containsRawArguments: true })),
    ).toMatchObject({ reasonCode: "contains-sensitive-content" });
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ containsSecrets: true })),
    ).toMatchObject({ reasonCode: "contains-sensitive-content" });
  });

  it("⑤ 空章节 / 未知章节 ⇒ 拒绝（不得把任意内部数据塞进证据包）", () => {
    expect(evaluateDiagnosticEvidencePackExport(exportInput({ sections: [] }))).toMatchObject({
      reasonCode: "no-sections",
    });
    expect(
      evaluateDiagnosticEvidencePackExport(exportInput({ sections: ["raw-logs"] })),
    ).toMatchObject({ reasonCode: "unknown-section" });
  });

  it("⑥ 清单固化三项安全常量，且白名单章节集合稳定", () => {
    const manifest = buildDiagnosticEvidencePackManifest({
      generatedAtIso: "2026-10-19T12:00:00.000Z",
      astarrayVersion: "0.1.0",
      platform: "linux-arm64",
      windowStartIso: "2026-10-19T00:00:00.000Z",
      windowEndIso: "2026-10-19T12:00:00.000Z",
      findingCount: 3,
      sections: ["findings-summary"],
      redactionSummary: "已脱敏",
    });
    expect(manifest.isAutoUploaded).toBe(false);
    expect(manifest.containsRawArguments).toBe(false);
    expect(manifest.containsSecrets).toBe(false);
    expect(manifest.findingCount).toBe(3);
    expect([...DIAGNOSTIC_EVIDENCE_PACK_SECTIONS]).toEqual([
      "findings-summary",
      "coverage-window",
      "redaction-notes",
      "degraded-status",
    ]);
  });
});
