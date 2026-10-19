/**
 * DIAG 证据包契约（2026-10-19 R61）。
 *
 * 卡内依据（`docs/tasks/OBS01_PERFORMANCE_USAGE_AND_DIAGNOSTICS_TASK_CARDS.md` §DIAG）：
 * "持久汇总、分页、只读规则诊断及**证据包**"；§2 "导出附**版本、平台、时间窗口及脱敏说明**，
 * **不自动联网发送**"、"日志在写入前最小化、清洗；**不保存**默认 prompt/回复正文、环境变量、
 * 凭据、请求头、敏感文件正文或完整命令参数"。
 *
 * 本模块只做**强制校验**（纯判定）：证据包**允许导出**的前提是
 * ①由用户主动发起；②不请求联网上传；③时间窗口非空；④不含原始参数/凭据/原始错误文本；
 * ⑤带有平台、版本与脱敏说明。缺任何一项即拒绝，并给出稳定原因码。
 *
 * ## 边界
 * 纯判定：不打包文件、不读诊断库、不联网。
 */
/** 证据包章节（只允许这些）。 */
export const DIAGNOSTIC_EVIDENCE_PACK_SECTIONS = [
  "findings-summary",
  "coverage-window",
  "redaction-notes",
  "degraded-status",
] as const;

export type DiagnosticEvidencePackSection =
  (typeof DIAGNOSTIC_EVIDENCE_PACK_SECTIONS)[number];

/** 证据包清单（导出前必须满足）。 */
export interface DiagnosticEvidencePackManifest {
  readonly schemaVersion: 1;
  readonly generatedAtIso: string;
  readonly astarrayVersion: string;
  /** 平台标识（如 `win32-x64` / `linux-arm64`）；用于跨平台复现。 */
  readonly platform: string;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly findingCount: number;
  readonly sections: ReadonlyArray<DiagnosticEvidencePackSection>;
  /** 脱敏说明（人可读，必须非空）。 */
  readonly redactionSummary: string;
  /** 恒为 false：证据包**不自动联网发送**。 */
  readonly isAutoUploaded: false;
  /** 恒为 false：不包含原始命令参数。 */
  readonly containsRawArguments: false;
  /** 恒为 false：不包含凭据/环境变量/请求头。 */
  readonly containsSecrets: false;
}

/** 导出判定结论。 */
export type DiagnosticEvidencePackExportDecision =
  | { readonly kind: "allowed"; readonly reason: string }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "not-user-initiated"
        | "auto-upload-requested"
        | "missing-time-window"
        | "missing-platform-or-version"
        | "missing-redaction-summary"
        | "no-sections"
        | "contains-sensitive-content"
        | "unknown-section";
      readonly reason: string;
    };

/** 判定能否生成/导出证据包。 */
export function evaluateDiagnosticEvidencePackExport(input: {
  readonly isUserInitiated: boolean;
  readonly isNetworkUploadRequested: boolean;
  readonly windowStartIso: string | null;
  readonly windowEndIso: string | null;
  readonly astarrayVersion: string;
  readonly platform: string;
  readonly redactionSummary: string;
  readonly sections: ReadonlyArray<string>;
  readonly containsRawArguments: boolean;
  readonly containsSecrets: boolean;
}): DiagnosticEvidencePackExportDecision {
  if (!input.isUserInitiated) {
    return {
      kind: "rejected",
      reasonCode: "not-user-initiated",
      reason: "证据包只能由用户主动发起导出（不自动生成、不自动发送）。",
    };
  }
  if (input.isNetworkUploadRequested) {
    return {
      kind: "rejected",
      reasonCode: "auto-upload-requested",
      reason: "证据包不自动联网发送：如需外发必须由用户自行处理导出文件。",
    };
  }
  if (
    input.windowStartIso === null ||
    input.windowEndIso === null ||
    input.windowStartIso.trim() === "" ||
    input.windowEndIso.trim() === ""
  ) {
    return {
      kind: "rejected",
      reasonCode: "missing-time-window",
      reason: "缺少时间窗口：无法界定证据覆盖范围。",
    };
  }
  if (input.astarrayVersion.trim() === "" || input.platform.trim() === "") {
    return {
      kind: "rejected",
      reasonCode: "missing-platform-or-version",
      reason: "缺少版本或平台：跨平台复现会失真。",
    };
  }
  if (input.redactionSummary.trim() === "") {
    return {
      kind: "rejected",
      reasonCode: "missing-redaction-summary",
      reason: "缺少脱敏说明：读者无法判断导出内容是否已清洗。",
    };
  }
  if (input.containsRawArguments || input.containsSecrets) {
    return {
      kind: "rejected",
      reasonCode: "contains-sensitive-content",
      reason: "含原始参数或凭据/环境变量：违反\"写入前最小化、清洗\"，禁止导出。",
    };
  }
  if (input.sections.length === 0) {
    return {
      kind: "rejected",
      reasonCode: "no-sections",
      reason: "没有指定任何证据章节：空包不是证据。",
    };
  }
  const unknownSections = input.sections.filter(
    (section) =>
      !DIAGNOSTIC_EVIDENCE_PACK_SECTIONS.includes(section as DiagnosticEvidencePackSection),
  );
  if (unknownSections.length > 0) {
    return {
      kind: "rejected",
      reasonCode: "unknown-section",
      reason: `存在未知证据章节（不得把任意内部数据塞进证据包）：${unknownSections.join(", ")}`,
    };
  }
  return { kind: "allowed", reason: "用户主动导出、窗口/版本/平台/脱敏说明齐备且无敏感内容。" };
}

/** 生成清单（校验通过后调用；常量字段由契约固化）。 */
export function buildDiagnosticEvidencePackManifest(input: {
  readonly generatedAtIso: string;
  readonly astarrayVersion: string;
  readonly platform: string;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly findingCount: number;
  readonly sections: ReadonlyArray<DiagnosticEvidencePackSection>;
  readonly redactionSummary: string;
}): DiagnosticEvidencePackManifest {
  return {
    schemaVersion: 1,
    generatedAtIso: input.generatedAtIso,
    astarrayVersion: input.astarrayVersion,
    platform: input.platform,
    windowStartIso: input.windowStartIso,
    windowEndIso: input.windowEndIso,
    findingCount: input.findingCount,
    sections: input.sections,
    redactionSummary: input.redactionSummary,
    isAutoUploaded: false,
    containsRawArguments: false,
    containsSecrets: false,
  };
}
