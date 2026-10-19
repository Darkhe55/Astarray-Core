/**
 * OBS 会话采集器（2026-10-19 R57）：把"调度器 + 采样 tick + 落盘 + 保留执行"组合成一个可测单元。
 *
 * 设计纪律（延续 R37/R39/R51/R54/R56）：
 * - **默认不采集**：`isCollectionEnabled:false` ⇒ `start()` 不排定时器、不写任何文件；
 * - **不常驻**：`stop()` 清定时器，并在关闭时**按保留策略整理一次**（先备份再重写，R54）；
 * - **观测故障不阻塞业务**：tick 失败只累计丢样，`start()/stop()` 不抛业务错误；
 * - **端口注入**：定时器、指标读取、时钟、落盘全部可注入 ⇒ 测试不碰真实磁盘/时钟。
 */
import { applyProcessSampleRetention } from "./process-sample-retention-apply.js";
import { createPerfSamplingScheduler, type PerfSchedulingTimerPort } from "./observability-sampling-scheduler.js";
import { runPerfSamplingTick, type PerfSamplingPorts } from "./observability-sampler.js";

/** 会话采集器。 */
export interface SessionPerfCollector {
  readonly start: () => { readonly kind: "started" | "not-started"; readonly reason: string };
  readonly stop: () => Promise<{
    readonly kind: "stopped" | "not-running";
    readonly droppedSampleCount: number;
    readonly retention: { readonly kind: "no-action" | "rewritten" | "abandoned"; readonly reason: string } | null;
  }>;
  readonly sampleNow: () => Promise<{ readonly kind: string; readonly reason: string }>;
  readonly getDroppedSampleCount: () => number;
  readonly isRunning: () => boolean;
}

/** 创建会话采集器。 */
export function createSessionPerfCollector(input: {
  readonly timerPort: PerfSchedulingTimerPort;
  readonly samplingPorts: PerfSamplingPorts;
  readonly baseDirectory: string;
  readonly isCollectionEnabled: boolean;
  readonly agentInstanceIdentifier: string | null;
  readonly intervalSeconds?: number;
  readonly nowIso?: () => string;
  readonly storageBytesUsed?: () => number;
}): SessionPerfCollector {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const storageBytesUsed = input.storageBytesUsed ?? (() => 0);
  let lastSampleAtIso: string | null = null;
  let droppedSampleCount = 0;

  const sampleOnce = async (): Promise<{ kind: string; reason: string }> => {
    if (!input.isCollectionEnabled) {
      return { kind: "skipped", reason: "采集未开启：不采样、不写盘。" };
    }
    const outcome = await runPerfSamplingTick({
      ports: input.samplingPorts,
      isCollectionEnabled: true,
      lastSampleAtIso,
      storageBytesUsed: storageBytesUsed(),
      agentInstanceIdentifier: input.agentInstanceIdentifier,
      previousDroppedSampleCount: droppedSampleCount,
      ...(input.intervalSeconds === undefined
        ? {}
        : { minimumSampleIntervalSeconds: input.intervalSeconds }),
    });
    droppedSampleCount = outcome.droppedSampleCount;
    if (outcome.kind === "sampled") lastSampleAtIso = nowIso();
    return { kind: outcome.kind, reason: outcome.reason };
  };

  const scheduler = createPerfSamplingScheduler({
    timerPort: input.timerPort,
    isCollectionEnabled: input.isCollectionEnabled,
    ...(input.intervalSeconds === undefined ? {} : { intervalSeconds: input.intervalSeconds }),
    onTick: () => {
      void sampleOnce();
    },
  });

  return {
    start: () => scheduler.start(),
    stop: async () => {
      const stopOutcome = scheduler.stop();
      if (stopOutcome.kind === "not-running") {
        return { kind: "not-running", droppedSampleCount, retention: null };
      }
      let retention: { kind: "no-action" | "rewritten" | "abandoned"; reason: string };
      try {
        const retentionReport = await applyProcessSampleRetention({
          baseDirectory: input.baseDirectory,
          nowIso: nowIso(),
          ...(input.intervalSeconds === undefined ? {} : {}),
        });
        retention = { kind: retentionReport.kind, reason: retentionReport.reason };
      } catch (error) {
        // 关闭时整理失败：如实报告，不抛给业务
        retention = {
          kind: "abandoned",
          reason: `关闭时整理失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { kind: "stopped", droppedSampleCount, retention };
    },
    sampleNow: sampleOnce,
    getDroppedSampleCount: () => droppedSampleCount,
    isRunning: () => scheduler.isRunning(),
  };
}

