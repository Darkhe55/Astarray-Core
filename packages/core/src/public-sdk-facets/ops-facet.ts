/**
 * AXIOMATIC-DESIGN 阶段②（P2，2026-11-26）：**运维/只读查询子门面**。
 *
 * 从 `public-sdk.ts` 中切出"启动恢复状态、实验目录、成果记录、任务级成果投影"这组**只读**方法：
 * 只依赖 runtime 的若干只读存储读取与 controller 的任务链查询 ⇒ 依赖面窄、可独立测试。
 *
 * 约束：
 * - 行为与门面原实现逐字一致（含 `assertOpen()` 先判）；
 * - 门面保留同名方法并委托（导出面不变）；
 * - 宿主以**窄接口**注入，避免子门面反向依赖 8540 行门面类型。
 */
import type { ExperimentSettingsStore } from "../orchestration/experiment-catalog.js";
import type { StartupRecoveryBootReport } from "../orchestration/startup-recovery-report.js";
import type { StartupRecoveryPolicy } from "../orchestration/startup-recovery-policy.js";
import type {
  ArtifactRecord,
  ArtifactRecordDocument,
} from "../orchestration/artifact-record-store.js";
import type { ToolFailureTokenTraceReport } from "../orchestration/tool-failure-token-trace.js";
import {
  buildToolFailureTokenTraces,
  extractToolActivityEvents,
} from "../orchestration/tool-failure-token-trace.js";

/** 运行历史读取结论（只读；缺失/损坏如实返回，不伪造完整）。 */
export type RunHistoryReadView =
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | {
      readonly kind: "valid";
      readonly document: {
        readonly missionIdentifier: string;
        readonly segments: ReadonlyArray<{
          readonly events: ReadonlyArray<{
            readonly kind: string;
            readonly recordedAtIso: string;
            readonly payloadJson: string;
          }>;
        }>;
      };
    };

export interface ProviderUsagePointView {
  readonly requestIdentifier: string;
  readonly missionIdentifier: string | null;
  readonly inputTokenCount: number | null;
  readonly outputTokenCount: number | null;
  readonly recordedAtIso: string;
}

type ExperimentSettingsDocument = Awaited<ReturnType<ExperimentSettingsStore["read"]>>;

/** 子门面所需的最小宿主能力。 */
export interface OpsFacetHost {
  assertOpen(): void;
  readStartupRecoveryPolicy(): Promise<{
    policy: StartupRecoveryPolicy;
    isPersisted: boolean;
  }>;
  readStartupRecoveryReport(): Promise<StartupRecoveryBootReport | null>;
  readExperimentSettings(): Promise<ExperimentSettingsDocument>;
  readArtifactRecords(): Promise<ArtifactRecordDocument>;
  readRunHistory(missionIdentifier: string): Promise<RunHistoryReadView>;
  readUsageLedgerEntries(): Promise<ReadonlyArray<ProviderUsagePointView>>;
  queryMissionStatus(missionId: string): Promise<{
    taskChain: {
      tasks: ReadonlyArray<{
        id: string;
        description: string;
        status: string;
        resultLocation: string | null;
      }>;
    } | null;
  }>;
}

export class OpsFacet {
  constructor(private readonly host: OpsFacetHost) {}

  async queryStartupRecoveryState(): Promise<{
    policy: StartupRecoveryPolicy;
    isPersisted: boolean;
    report: StartupRecoveryBootReport | null;
  }> {
    this.host.assertOpen();
    const { policy, isPersisted } = await this.host.readStartupRecoveryPolicy();
    const report = await this.host.readStartupRecoveryReport();
    return { policy, isPersisted, report };
  }

  async queryExperimentCatalog() {
    this.host.assertOpen();
    const settings = await this.host.readExperimentSettings();
    const { EXPERIMENT_CATALOG } = await import("../orchestration/experiment-catalog.js");
    return {
      settings,
      entries: EXPERIMENT_CATALOG.map((entry) => ({
        ...entry,
        isEnabled: settings.enabledExperimentIdentifiers.includes(entry.experimentIdentifier),
        canEnable: entry.runtimeConsumerWired,
      })),
    };
  }

  /** GUI-03-06：读取成果记录；可按项目/任务过滤。 */
  async queryArtifacts(input?: {
    projectIdentifier?: string;
    missionIdentifier?: string;
  }): Promise<ArtifactRecord[]> {
    this.host.assertOpen();
    const document = await this.host.readArtifactRecords();
    return document.records.filter(
      (record) =>
        (input?.projectIdentifier === undefined ||
          record.projectIdentifier === input.projectIdentifier) &&
        (input?.missionIdentifier === undefined ||
          record.missionIdentifier === input.missionIdentifier),
    );
  }

  /** GUI-03-06：任务成果记录（仅投影任务链已有的 resultLocation，不扫描项目树）。 */
  async queryMissionArtifacts(missionId: string): Promise<
    Array<{
      artifactIdentifier: string;
      taskIdentifier: string;
      description: string;
      status: string;
      location: string;
      source: "task-result-location";
    }>
  > {
    this.host.assertOpen();
    const status = await this.host.queryMissionStatus(missionId);
    if (status.taskChain === null) return [];
    return status.taskChain.tasks
      .filter(
        (task) => typeof task.resultLocation === "string" && task.resultLocation.trim() !== "",
      )
      .map((task) => ({
        artifactIdentifier: "task-result:" + task.id,
        taskIdentifier: task.id,
        description: task.description,
        status: task.status,
        location: task.resultLocation ?? "",
        source: "task-result-location" as const,
      }));
  }
  /**
   * TOKTRACE-01：**工具失败 → 下一次成功的 token 消耗与日志**（只读关联）。
   *
   * 口径：同一 mission 内，某工具失败后到它下一次成功前的全部 Provider 请求用量求和；
   * 未关窗只计数不产出 trace；历史缺失/损坏如实标注，不伪造。
   */
  async queryToolFailureTokenTraces(input: {
    missionIdentifier: string;
  }): Promise<
    ToolFailureTokenTraceReport & {
      readonly status: "ok" | "absent" | "invalid";
      readonly reason: string | null;
    }
  > {
    this.host.assertOpen();
    const history = await this.host.readRunHistory(input.missionIdentifier);
    if (history.kind !== "valid") {
      return {
        traces: [],
        openWindowCount: 0,
        skippedEventCount: 0,
        status: history.kind,
        reason: history.reason,
      };
    }
    const extracted = extractToolActivityEvents(history.document);
    const usageEntries = await this.host.readUsageLedgerEntries();
    const report = buildToolFailureTokenTraces({
      toolEvents: extracted.events,
      usageObservations: usageEntries.map((entry) => ({
        missionIdentifier: entry.missionIdentifier,
        inputTokenCount: entry.inputTokenCount,
        outputTokenCount: entry.outputTokenCount,
        observedAtIso: entry.recordedAtIso,
        requestIdentifier: entry.requestIdentifier,
      })),
    });
    return {
      ...report,
      skippedEventCount: report.skippedEventCount + extracted.skippedEventCount,
      status: "ok",
      reason: null,
    };
  }

}
