/**
 * 采样调度器的反例（2026-10-19 R56）。
 *
 * 覆盖：默认关闭不排定时器、重复 start 不产生第二个定时器、stop 必清理且幂等、
 * 间隔小于 5s 直接拒绝、tick 计数与注入端口一致。
 */
import { describe, expect, it, vi } from "vitest";

import { createPerfSamplingScheduler } from "../../../packages/core/src/orchestration/observability-sampling-scheduler.js";

interface FakeTimerPort {
  readonly setInterval: (callback: () => void, intervalMilliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly activeHandles: () => number;
  readonly scheduledIntervals: number[];
  readonly fireAll: () => void;
}

function buildFakeTimerPort(): FakeTimerPort {
  const callbacks = new Map<unknown, () => void>();
  const scheduledIntervals: number[] = [];
  let nextHandle = 1;
  return {
    setInterval: (callback, intervalMilliseconds) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      scheduledIntervals.push(intervalMilliseconds);
      return handle;
    },
    clearInterval: (handle) => {
      callbacks.delete(handle);
    },
    activeHandles: () => callbacks.size,
    scheduledIntervals,
    fireAll: () => {
      for (const callback of [...callbacks.values()]) callback();
    },
  };
}

describe("OBS 采样调度器", () => {
  it("① 默认关闭 ⇒ 不排定时器（显式开启前零开销）", () => {
    const timerPort = buildFakeTimerPort();
    const scheduler = createPerfSamplingScheduler({
      timerPort,
      isCollectionEnabled: false,
      onTick: () => undefined,
    });
    const outcome = scheduler.start();
    expect(outcome.kind).toBe("not-started");
    expect(outcome.reason).toContain("默认关闭");
    expect(timerPort.activeHandles()).toBe(0);
    expect(scheduler.isRunning()).toBe(false);
  });

  it("② 开启后 start 排定 5s 定时器；重复 start 不产生第二个", () => {
    const timerPort = buildFakeTimerPort();
    const scheduler = createPerfSamplingScheduler({
      timerPort,
      isCollectionEnabled: true,
      onTick: () => undefined,
    });
    expect(scheduler.start().kind).toBe("started");
    expect(timerPort.scheduledIntervals).toEqual([5000]);
    expect(scheduler.start().kind).toBe("not-started");
    expect(timerPort.activeHandles()).toBe(1);
    expect(scheduler.isRunning()).toBe(true);
  });

  it("③ stop 必清理且幂等；停止后不再计数", () => {
    const timerPort = buildFakeTimerPort();
    const onTick = vi.fn();
    const scheduler = createPerfSamplingScheduler({
      timerPort,
      isCollectionEnabled: true,
      onTick,
    });
    scheduler.start();
    timerPort.fireAll();
    expect(scheduler.getTickCount()).toBe(1);

    expect(scheduler.stop().kind).toBe("stopped");
    expect(timerPort.activeHandles()).toBe(0);
    expect(scheduler.stop().kind).toBe("not-running");
    timerPort.fireAll();
    expect(scheduler.getTickCount()).toBe(1);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("④ 间隔小于 5s ⇒ 直接拒绝（不静默改成别的值）", () => {
    expect(() =>
      createPerfSamplingScheduler({
        timerPort: buildFakeTimerPort(),
        isCollectionEnabled: true,
        intervalSeconds: 1,
        onTick: () => undefined,
      }),
    ).toThrow(/不得小于 5s/);
  });

  it("⑤ 自定义合法间隔（>5s）按请求排定", () => {
    const timerPort = buildFakeTimerPort();
    createPerfSamplingScheduler({
      timerPort,
      isCollectionEnabled: true,
      intervalSeconds: 30,
      onTick: () => undefined,
    }).start();
    expect(timerPort.scheduledIntervals).toEqual([30_000]);
  });
});
