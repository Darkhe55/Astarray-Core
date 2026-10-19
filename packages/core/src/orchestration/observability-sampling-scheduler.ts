/**
 * OBS 采样调度器（2026-10-19 R56）：把"每 ≥5s 采一次"接到可测的定时器端口上。
 *
 * 用户 2026-10-19 决策（按推荐）：**默认 off**、每进程 **≤1 样本/5s**。
 * 设计纪律：
 * - **定时器端口注入**（`setInterval`/`clearInterval`），测试用假实现，不依赖真实时钟；
 * - **默认不常驻**：只有 `isCollectionEnabled` 且显式 `start()` 才排定时器；
 * - **幂等**：重复 `start()` 不产生第二个定时器；`stop()` 幂等且必清理；
 * - **间隔下限 5s**：小于下限的请求**直接拒绝**（返回原因，不静默改成别的值）；
 * - 每次 tick 只调用注入的 `onTick`（由它跑 `runPerfSamplingTick`），
 *   调度器**自己不写盘、不读指标**。
 */
import { DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS } from "./observability-collection-contract.js";

/** 定时器端口（测试可注入假实现）。 */
export interface PerfSchedulingTimerPort {
  readonly setInterval: (callback: () => void, intervalMilliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

/** 调度器状态与操作。 */
export interface PerfSamplingScheduler {
  readonly start: () => { readonly kind: "started" | "not-started"; readonly reason: string };
  readonly stop: () => { readonly kind: "stopped" | "not-running"; readonly reason: string };
  readonly isRunning: () => boolean;
  /** 仅供测试/诊断：已触发的 tick 次数。 */
  readonly getTickCount: () => number;
}

/** 创建调度器。 */
export function createPerfSamplingScheduler(input: {
  readonly timerPort: PerfSchedulingTimerPort;
  readonly isCollectionEnabled: boolean;
  readonly intervalSeconds?: number;
  readonly onTick: () => void | Promise<void>;
}): PerfSamplingScheduler {
  const intervalSeconds = input.intervalSeconds ?? DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS) {
    throw new Error(
      `采样间隔不得小于 ${String(DEFAULT_PERF_SAMPLE_INTERVAL_SECONDS)}s（收到 ${String(intervalSeconds)}s）`,
    );
  }
  let timerHandle: unknown = null;
  let tickCount = 0;

  const stop = (): { kind: "stopped" | "not-running"; reason: string } => {
    if (timerHandle === null) {
      return { kind: "not-running", reason: "调度器未运行：无需停止。" };
    }
    input.timerPort.clearInterval(timerHandle);
    timerHandle = null;
    return { kind: "stopped", reason: "已停止并清理定时器。" };
  };

  return {
    start: () => {
      if (!input.isCollectionEnabled) {
        return {
          kind: "not-started",
          reason: "PERF 采集默认关闭：未显式开启前不排定时器。",
        };
      }
      if (timerHandle !== null) {
        return { kind: "not-started", reason: "已在运行：重复 start 不会创建第二个定时器。" };
      }
      timerHandle = input.timerPort.setInterval(() => {
        tickCount += 1;
        void input.onTick();
      }, intervalSeconds * 1000);
      return { kind: "started", reason: `已按 ${String(intervalSeconds)}s 间隔排定采样。` };
    },
    stop,
    isRunning: () => timerHandle !== null,
    getTickCount: () => tickCount,
  };
}
