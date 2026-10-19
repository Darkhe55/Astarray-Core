/**
 * OBS 只读查询入口（2026-10-19 R38）：`astarray obs perf|diag`。
 *
 * 用户 2026-10-19 决策（按推荐）：**完全本地、CLI `--json` 只读可查**；观测本身不采 OS 级指标、
 * 不上传；**观测故障降级并报告，不阻塞业务**（R37 契约）。
 *
 * 只读纪律：不采样、不写盘、不清任务、不调模型；查询失败 ⇒ `kind:"degraded"`（不是"一切正常"）。
 */
import {
  DiagnosticEventStore,
  PerfEventStore,
  ProcessSampleStore,
  aggregateProcessSamples,
  buildDiagnosticEvidencePackManifest,
  evaluateDiagnosticEvidencePackExport,
  queryDiagnosticSummary,
  queryPerfOverview,
} from "../../../core/src/public-sdk.js";
import { EXIT_CODES, logToStderr, printJson } from "./json-output.js";

/** `obs perf` 输入。 */
export interface ObsPerfCommandInput {
  readonly stateDirectory: string;
  readonly windowStartIso?: string | null;
  readonly windowEndIso?: string | null;
  readonly detailLevel?: "summary" | "detail";
  readonly pageSize?: number;
  readonly cursor?: string | null;
  readonly isJsonOutput: boolean;
}

/** `obs diag` 输入。 */
export interface ObsDiagCommandInput {
  readonly stateDirectory: string;
  readonly missionIdentifier?: string | null;
  readonly sourceAgentInstanceId?: string | null;
  readonly windowStartIso?: string | null;
  readonly windowEndIso?: string | null;
  readonly pageSize?: number;
  readonly cursor?: string | null;
  readonly isJsonOutput: boolean;
}

/** 执行 `obs perf`：只读查询性能样本（摘要或明细分页）。 */
export async function executeObsPerfCommand(input: ObsPerfCommandInput): Promise<number> {
  const store = new PerfEventStore({ baseDirectory: input.stateDirectory });
  let result;
  try {
    result = await queryPerfOverview({
      store,
      query: {
        ...(input.windowStartIso === undefined ? {} : { windowStartIso: input.windowStartIso }),
        ...(input.windowEndIso === undefined ? {} : { windowEndIso: input.windowEndIso }),
        ...(input.detailLevel === undefined ? {} : { detailLevel: input.detailLevel }),
        ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
        ...(input.cursor === undefined || input.cursor === null ? {} : { cursor: input.cursor }),
      },
    });
  } catch (error) {
    /**
     * **观测故障不得阻塞业务**（R37 契约）：查询失败 ⇒ 降级并报告，
     * 不抛错、不假装"没有样本"（`hasSamples` 保持 false 且 `kind` 明确是 degraded）。
     */
    const payload = {
      kind: "degraded" as const,
      sampleCount: 0,
      hasSamples: false,
      reason: `性能样本查询失败：${error instanceof Error ? error.message : String(error)}`,
    };
    if (input.isJsonOutput) printJson(payload);
    else logToStderr(payload.reason);
    return EXIT_CODES.SUCCESS;
  }

  const sampleCount = result.page?.samples.length ?? 0;
  const payload = {
    kind: "ok" as const,
    coverage: result.coverage,
    metrics: result.metrics,
    page: result.page,
    alerts: result.alerts,
    retainedInMemorySampleCount: result.retainedInMemorySampleCount,
    hasSamples: result.coverage.matchedSampleCount > 0,
    returnedSampleCount: sampleCount,
    /**
     * **"没有样本" ≠ "用量为零"**（卡内：unknown 不记作零）。
     * 这里显式给出 `hasSamples`，让调用方不能把空结果当成 0 消耗。
     */
    notice:
      result.coverage.matchedSampleCount === 0
        ? "没有任何匹配样本（不代表用量为零：可能未开启采集或超出时间窗）。"
        : null,
  };

  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      [
        `性能样本：命中 ${String(result.coverage.matchedSampleCount)} / 总 ${String(result.coverage.totalSampleCount)}（窗口 ${String(result.coverage.windowStartIso ?? "不限")} ~ ${String(result.coverage.windowEndIso ?? "不限")}）`,
        `本次返回：${String(sampleCount)} 条${result.page?.nextCursor === null || result.page === null ? "（已到末页）" : `（下一页游标 ${String(result.page.nextCursor)}）`}`,
        ...(payload.notice === null ? [] : [`说明：${payload.notice}`]),
        "",
      ].join("\n"),
    );
  }
  return EXIT_CODES.SUCCESS;
}

/** 执行 `obs diag`：只读查询诊断摘要（按指纹聚合，带证据引用）。 */
export async function executeObsDiagCommand(input: ObsDiagCommandInput): Promise<number> {
  const store = new DiagnosticEventStore({ baseDirectory: input.stateDirectory });
  let summary;
  try {
    summary = await queryDiagnosticSummary({
      store,
      query: {
        ...(input.missionIdentifier === undefined
          ? {}
          : { missionIdentifier: input.missionIdentifier }),
        ...(input.sourceAgentInstanceId === undefined
          ? {}
          : { sourceAgentInstanceId: input.sourceAgentInstanceId }),
        ...(input.windowStartIso === undefined ? {} : { windowStartIso: input.windowStartIso }),
        ...(input.windowEndIso === undefined ? {} : { windowEndIso: input.windowEndIso }),
        ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
        ...(input.cursor === undefined || input.cursor === null ? {} : { cursor: input.cursor }),
      },
    });
  } catch (error) {
    const payload = {
      kind: "degraded" as const,
      findingCount: 0,
      hasFindings: false,
      reason: `诊断事件查询失败：${error instanceof Error ? error.message : String(error)}`,
    };
    if (input.isJsonOutput) printJson(payload);
    else logToStderr(payload.reason);
    return EXIT_CODES.SUCCESS;
  }

  const payload = {
    kind: "ok" as const,
    coverage: summary.coverage,
    deterministicFindings: summary.deterministicFindings,
    suspectedFindings: summary.suspectedFindings,
    insufficientEvidenceFindings: summary.insufficientEvidenceFindings,
    bySeverity: summary.bySeverity,
    byRecoveryState: summary.byRecoveryState,
    isReportable: summary.isReportable,
    unreportableReason: summary.unreportableReason,
    page: summary.page,
    hasFindings: summary.coverage.matchedEventCount > 0,
    notice:
      summary.coverage.matchedEventCount === 0
        ? "没有任何匹配诊断事件（不代表没有故障：可能未采集或超出时间窗）。"
        : null,
  };
  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      [
        `诊断事件：命中 ${String(summary.coverage.matchedEventCount)} / 总 ${String(summary.coverage.totalEventCount)}`,
        `分组（按指纹）：${String(summary.page?.groups.length ?? 0)} 组（可报告：${summary.isReportable ? "是" : `否 — ${String(summary.unreportableReason ?? "原因未知")}`}）`,
        ...(payload.notice === null ? [] : [`说明：${payload.notice}`]),
        "",
      ].join("\n"),
    );
  }
  return EXIT_CODES.SUCCESS;
}


/** `obs process` 输入：进程样本只读查询。 */
export interface ObsProcessCommandInput {
  readonly stateDirectory: string;
  /** 是否返回聚合摘要（而不是逐条样本）。 */
  readonly summarize?: boolean;
  readonly windowStartIso?: string | null;
  readonly windowEndIso?: string | null;
  readonly limit?: number;
  readonly isJsonOutput: boolean;
}

/**
 * 执行 `obs process`：只读查询**进程样本**（R51 的独立事件类型/独立文件）。
 *
 * 与 `obs perf` 同一纪律：**没有样本 ≠ 用量为零**；**观测故障降级、不阻塞业务**。
 */
export async function executeObsProcessCommand(
  input: ObsProcessCommandInput,
): Promise<number> {
  const store = new ProcessSampleStore({ baseDirectory: input.stateDirectory });
  let report;
  try {
    report = await store.readWithIntegrity();
  } catch (error) {
    const payload = {
      kind: "degraded" as const,
      sampleCount: 0,
      hasSamples: false,
      reason: `进程样本查询失败：${error instanceof Error ? error.message : String(error)}`,
    };
    if (input.isJsonOutput) printJson(payload);
    else logToStderr(payload.reason);
    return EXIT_CODES.SUCCESS;
  }

  const windowStartMilliseconds =
    input.windowStartIso === undefined || input.windowStartIso === null
      ? null
      : Date.parse(input.windowStartIso);
  const windowEndMilliseconds =
    input.windowEndIso === undefined || input.windowEndIso === null
      ? null
      : Date.parse(input.windowEndIso);
  const matchedSamples = report.samples.filter((sample) => {
    const recordedAtMilliseconds = Date.parse(sample.recordedAtIso);
    if (windowStartMilliseconds !== null && recordedAtMilliseconds < windowStartMilliseconds) {
      return false;
    }
    if (windowEndMilliseconds !== null && recordedAtMilliseconds > windowEndMilliseconds) {
      return false;
    }
    return true;
  });
  const limit = input.limit ?? 50;
  const returnedSamples = matchedSamples.slice(0, Math.max(0, limit));
  const droppedSampleCountTotal = report.samples.reduce(
    (total, sample) => total + sample.droppedSampleCount,
    0,
  );

  /**
   * `--summary`：返回**聚合摘要**（R58 的 `aggregateProcessSamples`），此时不再返回逐条样本。
   * 聚合口径与展示完全同源：缺字段不计入分母、全缺为 null（unknown 不记作零）。
   */
  const isSummaryRequested = input.summarize === true;
  const aggregate = isSummaryRequested
    ? aggregateProcessSamples({
        samples: matchedSamples,
        discardedLineCount: report.discardedLineCount,
      })
    : null;

  const payload = {
    kind: "ok" as const,
    coverage: {
      totalSampleCount: report.samples.length,
      matchedSampleCount: matchedSamples.length,
      returnedSampleCount: returnedSamples.length,
      discardedLineCount: report.discardedLineCount,
      windowStartIso: input.windowStartIso ?? null,
      windowEndIso: input.windowEndIso ?? null,
      droppedSampleCountTotal,
    },
    hasSamples: matchedSamples.length > 0,
    aggregate,
    samples: isSummaryRequested ? [] : returnedSamples,
    notice:
      matchedSamples.length === 0
        ? "没有任何匹配的进程样本（不代表没有资源消耗：可能未开启采集或超出时间窗）。"
        : null,
  };

  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      [
        `进程样本：命中 ${String(matchedSamples.length)} / 总 ${String(report.samples.length)}（丢弃行 ${String(report.discardedLineCount)}）`,
        `本次返回：${String(returnedSamples.length)} 条`,
        ...(payload.notice === null ? [] : [`说明：${payload.notice}`]),
        "",
      ].join("\n"),
    );
  }
  return EXIT_CODES.SUCCESS;
}


/** `obs diag export` 输入。 */
export interface ObsDiagExportCommandInput {
  readonly stateDirectory: string;
  readonly outputFilePath: string;
  readonly windowStartIso: string;
  readonly windowEndIso: string;
  readonly sections: ReadonlyArray<string>;
  readonly astarrayVersion: string;
  readonly platform: string;
  readonly redactionSummary: string;
  /** 恒为 true：只有用户主动执行命令才会走到这里。 */
  readonly isUserInitiated: true;
  readonly generatedAtIso: string;
  readonly findingCount?: number;
  readonly isJsonOutput: boolean;
}

/**
 * 执行 `obs diag export`：**用户主动**导出证据包到指定文件。
 *
 * 纪律（R61 契约）：不联网上传；窗口/版本/平台/脱敏说明必须齐备；
 * 章节走白名单；被拒绝时不写任何文件。
 */
export async function executeObsDiagExportCommand(
  input: ObsDiagExportCommandInput,
): Promise<number> {
  const decision = evaluateDiagnosticEvidencePackExport({
    isUserInitiated: true,
    isNetworkUploadRequested: false,
    windowStartIso: input.windowStartIso,
    windowEndIso: input.windowEndIso,
    astarrayVersion: input.astarrayVersion,
    platform: input.platform,
    redactionSummary: input.redactionSummary,
    sections: input.sections,
    containsRawArguments: false,
    containsSecrets: false,
  });
  if (decision.kind === "rejected") {
    // 被拒绝时**不写任何文件**
    logToStderr(`证据包导出被拒绝（${decision.reasonCode}）：${decision.reason}`);
    return EXIT_CODES.FAILURE;
  }

  const manifest = buildDiagnosticEvidencePackManifest({
    generatedAtIso: input.generatedAtIso,
    astarrayVersion: input.astarrayVersion,
    platform: input.platform,
    windowStartIso: input.windowStartIso,
    windowEndIso: input.windowEndIso,
    findingCount: input.findingCount ?? 0,
    sections: input.sections as never,
    redactionSummary: input.redactionSummary,
  });

  /**
   * **正文生成（R63）**：按用户给的窗口读取诊断摘要，只保留**指纹级聚合**。
   *
   * 刻意**不写** `messageText`、原始命令参数、请求头或凭据 —— 证据包的价值是"同类问题有几条、
   * 何时首次/最后出现、证据引用了哪些回执"，而不是把原始日志搬出来。
   */
  const diagnosticStore = new DiagnosticEventStore({ baseDirectory: input.stateDirectory });
  let summary;
  try {
    summary = await queryDiagnosticSummary({
      store: diagnosticStore,
      query: {
        windowStartIso: input.windowStartIso,
        windowEndIso: input.windowEndIso,
      },
    });
  } catch (error) {
    logToStderr(
      `证据包正文读取失败，未写文件：${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_CODES.FAILURE;
  }

  const findingsForPack = [
    ...summary.deterministicFindings,
    ...summary.suspectedFindings,
    ...summary.insufficientEvidenceFindings,
  ].map((finding) => ({
    fingerprint: finding.fingerprint,
    errorCode: finding.errorCode,
    component: finding.component,
    severity: finding.severity,
    occurrenceCount: finding.occurrenceCount,
    firstOccurredAtIso: finding.firstOccurredAtIso,
    lastOccurredAtIso: finding.lastOccurredAtIso,
    isInference: finding.isInference,
    evidence: {
      sourceAgentInstanceIdentifiers: finding.evidence.sourceAgentInstanceIds,
      requestIdentifiers: finding.evidence.requestIdentifiers,
    },
  }));

  /**
   * 正文**按声明章节组装**（R64）：用户选了哪些章节就只写哪些，声明与内容必须一致。
   *
   * - `findings-summary` ⇒ findings（指纹级）+ bySeverity/byRecoveryState
   * - `coverage-window` ⇒ coverage
   * - `redaction-notes` ⇒ redactionNotes（脱敏说明回显）
   * - `degraded-status` ⇒ 观测是否降级（丢弃行/不可报告原因）
   */
  const requestedSections = new Set(input.sections);
  const evidencePack = {
    manifest,
    body: {
      ...(requestedSections.has("coverage-window") ? { coverage: summary.coverage } : {}),
      ...(requestedSections.has("findings-summary")
        ? {
            findings: findingsForPack,
            bySeverity: summary.bySeverity,
            byRecoveryState: summary.byRecoveryState,
          }
        : {}),
      ...(requestedSections.has("redaction-notes")
        ? { redactionNotes: input.redactionSummary }
        : {}),
      ...(requestedSections.has("degraded-status")
        ? {
            degraded: {
              discardedLineCount: summary.coverage.discardedLineCount,
              isReportable: summary.isReportable,
              unreportableReason: summary.unreportableReason,
            },
          }
        : {}),
    },
  };

  const { writeAtomicTextFile } = await import("../../../core/src/infra/atomic-json.js");
  try {
    await writeAtomicTextFile(input.outputFilePath, `${JSON.stringify(evidencePack, null, 2)}\n`);
  } catch (error) {
    logToStderr(`证据包写入失败：${error instanceof Error ? error.message : String(error)}`);
    return EXIT_CODES.FAILURE;
  }

  const payload = {
    kind: "exported" as const,
    outputFilePath: input.outputFilePath,
    manifest,
    findingCount: findingsForPack.length,
    eventCount: summary.coverage.matchedEventCount,
    /** 明确报告"没有联网上传"，避免调用方误以为已外发。 */
    isAutoUploaded: false,
  };
  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      [
        `证据包已写入：${input.outputFilePath}`,
        `窗口：${input.windowStartIso} ~ ${input.windowEndIso}`,
        `章节：${input.sections.join(", ")}`,
        "说明：未联网上传；如需外发请自行处理该文件。",
        "",
      ].join("\n"),
    );
  }
  return EXIT_CODES.SUCCESS;
}
