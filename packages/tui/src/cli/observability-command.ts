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

