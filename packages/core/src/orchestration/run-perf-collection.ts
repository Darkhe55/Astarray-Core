/**
 * `run` 命令的 OBS 采集接线（2026-10-19 R68）。
 *
 * 用户 2026-10-19 决策：采集器**只接 `run` 命令**；开关 `--perf-collect`；**默认 off**。
 *
 * 为什么单独抽一个函数：`executeRunCommand` 体量大且难在测试里整跑，
 * 这里把"是否创建采集器 / 何时 start / 何时 stop"收成一个**可测单元**，
 * 由 run-command 在真装配点调用；真实定时器可由调用方注入（测试用假实现）。
 */
import {
  createSessionPerfCollector,
  type SessionPerfCollector,
} from "./session-perf-collector.js";
import { createProcessSampleStorePorts } from "./observability-sampler.js";
import { ProcessSampleStore } from "./process-sample-store.js";

/** 定时器端口默认实现（真实 `setInterval`/`clearInterval`）。 */
export const defaultSchedulingTimerPort = {
  setInterval: (callback: () => void, intervalMilliseconds: number): unknown =>
    setInterval(callback, intervalMilliseconds),
  clearInterval: (handle: unknown): void => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * 为一个 `run` 会话准备采集器。
 *
 * - `isPerfCollectionEnabled !== true` ⇒ **返回 null**（不创建任何对象、不建目录、零开销）；
 * - 开启时创建采集器（**未 start**），由调用方在会话开始/结束处 start/stop。
 */
export function prepareRunPerfCollection(input: {
  readonly stateDirectory: string;
  readonly isPerfCollectionEnabled: boolean;
  readonly agentInstanceIdentifier: string | null;
  readonly readProcessMetrics: () => Partial<Record<"residentMemoryBytes" | "eventLoopDelayMs" | "taskDurationMs" | "queueDepth", number>>;
  readonly schedulingTimerPort?: {
    readonly setInterval: (callback: () => void, intervalMilliseconds: number) => unknown;
    readonly clearInterval: (handle: unknown) => void;
  };
}): SessionPerfCollector | null {
  if (input.isPerfCollectionEnabled !== true) return null;
  const store = new ProcessSampleStore({ baseDirectory: input.stateDirectory });
  return createSessionPerfCollector({
    timerPort: input.schedulingTimerPort ?? defaultSchedulingTimerPort,
    samplingPorts: createProcessSampleStorePorts({
      store,
      readProcessMetrics: input.readProcessMetrics,
    }),
    baseDirectory: input.stateDirectory,
    isCollectionEnabled: true,
    agentInstanceIdentifier: input.agentInstanceIdentifier,
  });
}
