/**
 * 接线缺口第 ④ 项（2026-10-28）：**工作时段变化检测器**。
 *
 * 背景：`evaluateWorkWindowResume` 与 `MainController.handleWorkWindowResume` 都已实现，
 * 但**没有任何东西在 rest → working 时调用它们** —— 恢复入口存在，触发点不存在。
 *
 * 本模块提供可注入定时器的检测器（沿用 `observability-sampling-scheduler` 的纪律）：
 * - **默认关闭**：`isEnabled` 为 false 时不排定时器；
 * - **首次观测只建基线**：启动时状态已是 working 不会误触发恢复；
 * - **只在 rest → working 时触发一次**；working → resting 只记录状态；
 * - **最小间隔 60 秒**：小于下限直接拒绝（不静默改成别的值）；
 * - **读取失败不杀循环**：记录错误与次数，继续下一次观测；
 * - **不自己恢复任务**：只回调，是否调用 `handleWorkWindowResume` 由宿主决定
 *   （避免"检测器偷偷派发"）。
 */
export interface WorkWindowTransitionTimerPort {
  readonly setInterval: (callback: () => void, intervalMilliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export type WorkWindowObservedState = "working" | "resting";

export interface WorkWindowTransitionObservation {
  readonly kind:
    | "baseline-set"
    | "no-change"
    | "rest-to-working"
    | "working-to-resting"
    | "read-failed";
  readonly previousState: WorkWindowObservedState | null;
  readonly currentState: WorkWindowObservedState | null;
  readonly observedAtIso: string;
  readonly detail: string;
}

/** 检测器最小轮询间隔（秒）。低于此值直接拒绝。 */
export const MINIMUM_WORK_WINDOW_MONITOR_INTERVAL_SECONDS = 60;

/** 缺省轮询间隔（秒）：五分钟一次足够覆盖"整点/半小时"的时段边界。 */
export const DEFAULT_WORK_WINDOW_MONITOR_INTERVAL_SECONDS = 300;

export interface WorkWindowTransitionMonitorOptions {
  readonly timerPort: WorkWindowTransitionTimerPort;
  /** 默认 false：不排定时器。 */
  readonly isEnabled: boolean;
  readonly intervalSeconds?: number;
  readonly readCurrentState: (instantIso: string) => Promise<WorkWindowObservedState>;
  /** **只在 rest → working** 时调用；异常由本模块吞掉并计数（不炸定时器）。 */
  readonly onRestToWorking?: (observation: WorkWindowTransitionObservation) => void | Promise<void>;
  readonly onObservation?: (observation: WorkWindowTransitionObservation) => void;
  readonly nowIso?: () => string;
}

export interface WorkWindowTransitionMonitor {
  readonly start: () => { readonly kind: "started" | "not-started"; readonly reason: string };
  readonly stop: () => { readonly kind: "stopped" | "not-running"; readonly reason: string };
  readonly isRunning: () => boolean;
  readonly getTickCount: () => number;
  readonly getLastState: () => WorkWindowObservedState | null;
  readonly getReadFailureCount: () => number;
  /** 供宿主（既有调度循环/CLI）复用：不依赖定时器也能观测一次。 */
  readonly observeNow: () => Promise<WorkWindowTransitionObservation>;
}

export function createWorkWindowTransitionMonitor(
  input: WorkWindowTransitionMonitorOptions,
): WorkWindowTransitionMonitor {
  const intervalSeconds =
    input.intervalSeconds ?? DEFAULT_WORK_WINDOW_MONITOR_INTERVAL_SECONDS;
  if (
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < MINIMUM_WORK_WINDOW_MONITOR_INTERVAL_SECONDS
  ) {
    throw new Error(
      `时段检测间隔不得小于 ${String(MINIMUM_WORK_WINDOW_MONITOR_INTERVAL_SECONDS)}s（收到 ${String(intervalSeconds)}s）`,
    );
  }
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  let timerHandle: unknown = null;
  let tickCount = 0;
  let lastState: WorkWindowObservedState | null = null;
  let readFailureCount = 0;
  let isObserving = false;

  const observeNow = async (): Promise<WorkWindowTransitionObservation> => {
    /** 单飞：上一次观测未完成时不再叠加（避免慢读导致定时器堆积）。 */
    if (isObserving) {
      return {
        kind: "no-change",
        previousState: lastState,
        currentState: lastState,
        observedAtIso: nowIso(),
        detail: "上一次观测尚未完成：本次跳过（单飞）。",
      };
    }
    isObserving = true;
    const observedAtIso = nowIso();
    try {
      const currentState = await input.readCurrentState(observedAtIso);
      const previousState = lastState;
      lastState = currentState;
      let observation: WorkWindowTransitionObservation;
      if (previousState === null) {
        observation = {
          kind: "baseline-set",
          previousState: null,
          currentState,
          observedAtIso,
          detail: "首次观测：只建立基线，不触发恢复。",
        };
      } else if (previousState === currentState) {
        observation = {
          kind: "no-change",
          previousState,
          currentState,
          observedAtIso,
          detail: `状态未变化（${currentState}）。`,
        };
      } else if (currentState === "working") {
        observation = {
          kind: "rest-to-working",
          previousState,
          currentState,
          observedAtIso,
          detail: "从休息进入工作时段：触发一次恢复回调。",
        };
      } else {
        observation = {
          kind: "working-to-resting",
          previousState,
          currentState,
          observedAtIso,
          detail: "从工作进入休息：只记录状态，不恢复。",
        };
      }
      input.onObservation?.(observation);
      if (observation.kind === "rest-to-working" && input.onRestToWorking !== undefined) {
        try {
          await input.onRestToWorking(observation);
        } catch {
          /** 回调失败不改变已记录的观察结果，也不炸定时器。 */
        }
      }
      return observation;
    } catch {
      readFailureCount += 1;
      const observation: WorkWindowTransitionObservation = {
        kind: "read-failed",
        previousState: lastState,
        currentState: null,
        observedAtIso,
        detail: "读取当前时段状态失败：本轮不判定变化（保持上次状态）。",
      };
      input.onObservation?.(observation);
      return observation;
    } finally {
      isObserving = false;
    }
  };

  return {
    start: () => {
      if (!input.isEnabled) {
        return {
          kind: "not-started",
          reason: "时段恢复检测默认关闭：启动器未开启前不排定时器。",
        };
      }
      if (timerHandle !== null) {
        return { kind: "started", reason: "已在运行：重复 start 不产生第二个定时器。" };
      }
      timerHandle = input.timerPort.setInterval(() => {
        tickCount += 1;
        void observeNow();
      }, intervalSeconds * 1000);
      return {
        kind: "started",
        reason: `已启动：每 ${String(intervalSeconds)}s 观测一次时段状态。`,
      };
    },
    stop: () => {
      if (timerHandle === null) {
        return { kind: "not-running", reason: "检测器未运行：无需停止。" };
      }
      input.timerPort.clearInterval(timerHandle);
      timerHandle = null;
      return { kind: "stopped", reason: "已停止并清理定时器。" };
    },
    isRunning: () => timerHandle !== null,
    getTickCount: () => tickCount,
    getLastState: () => lastState,
    getReadFailureCount: () => readFailureCount,
    observeNow,
  };
}
