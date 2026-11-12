/**
 * 工作时段变化检测器（此前 `tests/` 零引用）。
 *
 * 核心语义：默认关闭 / 首次只建基线 / **只在 rest→working 触发一次** /
 * 间隔下限 60 秒（不静默改）/ 读取失败不杀循环 / 单飞防堆积 / 不自己恢复任务。
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORK_WINDOW_MONITOR_INTERVAL_SECONDS,
  MINIMUM_WORK_WINDOW_MONITOR_INTERVAL_SECONDS,
  createWorkWindowTransitionMonitor,
} from "../../../packages/core/src/orchestration/work-window-transition-monitor.js";
import type { WorkWindowObservedState } from "../../../packages/core/src/orchestration/work-window-transition-monitor.js";

function buildTimerPort() {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  return {
    port: {
      setInterval: (callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearInterval: (handle: unknown) => {
        cleared.push(handle);
      },
    },
    callbacks,
    cleared,
  };
}

function buildMonitor(options: {
  isEnabled?: boolean;
  states?: WorkWindowObservedState[];
  readCurrentState?: () => Promise<WorkWindowObservedState>;
  onRestToWorking?: () => void;
  intervalSeconds?: number;
}) {
  const timer = buildTimerPort();
  const states = options.states ?? [];
  const readCurrentState =
    options.readCurrentState ??
    (async () => {
      const next = states.shift();
      if (next === undefined) throw new Error("no-more-states");
      return next;
    });
  const monitor = createWorkWindowTransitionMonitor({
    timerPort: timer.port,
    isEnabled: options.isEnabled ?? true,
    ...(options.intervalSeconds === undefined ? {} : { intervalSeconds: options.intervalSeconds }),
    readCurrentState,
    ...(options.onRestToWorking === undefined ? {} : { onRestToWorking: options.onRestToWorking }),
    nowIso: () => "2026-11-12T00:00:00.000Z",
  } as never);
  return { monitor, timer };
}

describe("工作时段检测器", () => {
  it("① 默认关闭 ⇒ 不启动、不排定时器", () => {
    const { monitor, timer } = buildMonitor({ isEnabled: false });
    const started = monitor.start();
    expect(started.kind).toBe("not-started");
    expect(timer.callbacks).toHaveLength(0);
    expect(monitor.isRunning()).toBe(false);
  });

  it("② 间隔低于下限 ⇒ 创建即拒绝（不静默改成别的值）", () => {
    expect(() => buildMonitor({ intervalSeconds: MINIMUM_WORK_WINDOW_MONITOR_INTERVAL_SECONDS - 1 })).toThrow(
      /不得小于/u,
    );
    expect(DEFAULT_WORK_WINDOW_MONITOR_INTERVAL_SECONDS).toBeGreaterThanOrEqual(
      MINIMUM_WORK_WINDOW_MONITOR_INTERVAL_SECONDS,
    );
  });

  it("③ 首次观测只建基线，且不触发恢复", async () => {
    const onRestToWorking = vi.fn();
    const { monitor } = buildMonitor({ states: ["working"], onRestToWorking });
    const observation = await monitor.observeNow();
    expect(observation.kind).toBe("baseline-set");
    expect(onRestToWorking).not.toHaveBeenCalled();
    expect(monitor.getLastState()).toBe("working");
  });

  it("④ rest→working 恰好触发一次；后续 no-change 不再触发", async () => {
    const onRestToWorking = vi.fn();
    const { monitor } = buildMonitor({
      states: ["resting", "working", "working"],
      onRestToWorking,
    });
    expect((await monitor.observeNow()).kind).toBe("baseline-set");
    expect((await monitor.observeNow()).kind).toBe("rest-to-working");
    expect(onRestToWorking).toHaveBeenCalledTimes(1);
    expect((await monitor.observeNow()).kind).toBe("no-change");
    expect(onRestToWorking).toHaveBeenCalledTimes(1);
  });

  it("⑤ working→resting 只记录状态，不触发恢复", async () => {
    const onRestToWorking = vi.fn();
    const { monitor } = buildMonitor({ states: ["working", "resting"], onRestToWorking });
    await monitor.observeNow();
    const observation = await monitor.observeNow();
    expect(observation.kind).toBe("working-to-resting");
    expect(onRestToWorking).not.toHaveBeenCalled();
    expect(monitor.getLastState()).toBe("resting");
  });

  it("⑥ 读取失败 ⇒ read-failed、计数 +1、保持上次状态且不杀循环", async () => {
    let callCount = 0;
    const { monitor } = buildMonitor({
      readCurrentState: async () => {
        callCount += 1;
        if (callCount === 2) throw new Error("read-failed");
        return "working";
      },
    });
    await monitor.observeNow();
    const failed = await monitor.observeNow();
    expect(failed.kind).toBe("read-failed");
    expect(monitor.getReadFailureCount()).toBe(1);
    expect(monitor.getLastState()).toBe("working");
    /** 后续观测仍可继续。 */
    expect((await monitor.observeNow()).kind).toBe("no-change");
  });

  it("⑦ 单飞：上一次观测未完成时再次观测 ⇒ 跳过且不改状态", async () => {
    let release: (() => void) | undefined;
    const { monitor } = buildMonitor({
      readCurrentState: async () =>
        await new Promise<WorkWindowObservedState>((resolve) => {
          release = () => resolve("resting");
        }),
    });
    const first = monitor.observeNow();
    const second = await monitor.observeNow();
    expect(second.detail).toContain("上一次观测尚未完成");
    (release as (() => void) | undefined)?.();
    expect((await first).kind).toBe("baseline-set");
  });

  it("⑧ start 幂等、stop 清理、tick 计数随定时器回调递增", () => {
    const { monitor, timer } = buildMonitor({ states: ["working"] });
    expect(monitor.start().kind).toBe("started");
    expect(monitor.start().kind).toBe("started");
    expect(timer.callbacks).toHaveLength(1);
    timer.callbacks[0]?.();
    expect(monitor.getTickCount()).toBe(1);
    expect(monitor.stop().kind).toBe("stopped");
    expect(timer.cleared).toHaveLength(1);
    expect(monitor.stop().kind).toBe("not-running");
  });
});
