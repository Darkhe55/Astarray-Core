/**
 * 会话采集器的反例（2026-10-19 R57）。
 *
 * 覆盖：默认关闭不排定时器也不写盘、开启后按 tick 落盘、stop 清定时器并按保留策略整理、
 * tick 失败只累计丢样（不抛业务错误）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProcessSampleStore } from "../../../packages/core/src/orchestration/process-sample-store.js";
import { createSessionPerfCollector } from "../../../packages/core/src/orchestration/session-perf-collector.js";
import type { PerfSamplingPorts } from "../../../packages/core/src/orchestration/observability-sampler.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-session-collector-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fakeTimerPort() {
  const callbacks = new Map<unknown, () => void>();
  let nextHandle = 1;
  return {
    setInterval: (callback: () => void) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    clearInterval: (handle: unknown) => {
      callbacks.delete(handle);
    },
    activeHandles: () => callbacks.size,
  };
}

function buildSamplingPorts(options: {
  readonly store: ProcessSampleStore;
  readonly metrics?: Record<string, number>;
  readonly appendFailure?: Error;
}): PerfSamplingPorts {
  return {
    readProcessMetrics: () => options.metrics ?? { residentMemoryBytes: 1024 },
    /** 采样时钟用真实时间：固定常量会随日历过期（2026-10-20 实测：24h 保留窗口把旧样本裁掉，反例假红）。 */
    readNowIso: () => new Date().toISOString(),
    readProcessIdentifier: () => 7,
    appendSample: async (sample) => {
      if (options.appendFailure !== undefined) throw options.appendFailure;
      await options.store.append({
        observeEventVersion: 1,
        eventType: "process",
        recordedAtIso: sample.sampledAtIso,
        processIdentifier: sample.processIdentifier,
        agentInstanceIdentifier: sample.agentInstanceIdentifier,
        fields: sample.fields,
        droppedSampleCount: sample.droppedSampleCount,
      });
    },
  };
}

describe("OBS 会话采集器", () => {
  it("① 默认关闭 ⇒ 不排定时器、不写任何文件", async () => {
    const timerPort = fakeTimerPort();
    const store = new ProcessSampleStore({ baseDirectory });
    const collector = createSessionPerfCollector({
      timerPort,
      samplingPorts: buildSamplingPorts({ store }),
      baseDirectory,
      isCollectionEnabled: false,
      agentInstanceIdentifier: "agent-1",
    });

    expect(collector.start().kind).toBe("not-started");
    expect(timerPort.activeHandles()).toBe(0);
    expect((await collector.sampleNow()).kind).toBe("skipped");
    await expect(fs.access(path.join(baseDirectory, "perf"))).rejects.toThrow();
  });

  it("② 开启后 sampleNow 落盘一条；stop 清定时器并按保留策略整理", async () => {
    const timerPort = fakeTimerPort();
    const store = new ProcessSampleStore({ baseDirectory });
    const collector = createSessionPerfCollector({
      timerPort,
      samplingPorts: buildSamplingPorts({ store }),
      baseDirectory,
      isCollectionEnabled: true,
      agentInstanceIdentifier: "agent-1",
    });

    expect(collector.start().kind).toBe("started");
    expect(timerPort.activeHandles()).toBe(1);
    expect((await collector.sampleNow()).kind).toBe("sampled");
    const beforeStop = await store.readWithIntegrity();
    expect(beforeStop.samples).toHaveLength(1);

    const stopOutcome = await collector.stop();
    expect(stopOutcome.kind).toBe("stopped");
    expect(timerPort.activeHandles()).toBe(0);
    // 一条样本且在保留期内 ⇒ 无需裁剪
    expect(stopOutcome.retention?.kind).toBe("no-action");
  });

  it("③ tick 落盘失败 ⇒ 只累计丢样，不抛给调用方", async () => {
    const timerPort = fakeTimerPort();
    const store = new ProcessSampleStore({ baseDirectory });
    const collector = createSessionPerfCollector({
      timerPort,
      samplingPorts: buildSamplingPorts({ store, appendFailure: new Error("disk full") }),
      baseDirectory,
      isCollectionEnabled: true,
      agentInstanceIdentifier: "agent-1",
    });

    const outcome = await collector.sampleNow();
    expect(outcome.kind).toBe("degraded");
    expect(collector.getDroppedSampleCount()).toBe(1);
  });

  it("④ 未 start 就 stop ⇒ not-running（幂等，不整理、不抛错）", async () => {
    const collector = createSessionPerfCollector({
      timerPort: fakeTimerPort(),
      samplingPorts: buildSamplingPorts({ store: new ProcessSampleStore({ baseDirectory }) }),
      baseDirectory,
      isCollectionEnabled: true,
      agentInstanceIdentifier: "agent-1",
    });
    const outcome = await collector.stop();
    expect(outcome.kind).toBe("not-running");
    expect(outcome.retention).toBeNull();
  });

  it("⑤ 白名单外指标 ⇒ degraded（不写盘），且丢样计数可见", async () => {
    const timerPort = fakeTimerPort();
    const store = new ProcessSampleStore({ baseDirectory });
    const collector = createSessionPerfCollector({
      timerPort,
      samplingPorts: buildSamplingPorts({ store, metrics: { cpuPercent: 42 } }),
      baseDirectory,
      isCollectionEnabled: true,
      agentInstanceIdentifier: "agent-1",
    });
    const outcome = await collector.sampleNow();
    expect(outcome.kind).toBe("degraded");
    expect(collector.getDroppedSampleCount()).toBe(1);
    expect((await store.readWithIntegrity()).samples).toHaveLength(0);
  });

  it("⑥ stop 时按保留策略**真的整理**：过期样本被裁剪（kind=rewritten）", async () => {
    const timerPort = fakeTimerPort();
    const store = new ProcessSampleStore({ baseDirectory });
    // 预先塞一条 48 小时前的过期样本（采集器 nowIso 固定为 2026-10-19T12:00:00Z）
    await store.append({
      observeEventVersion: 1,
      eventType: "process",
      recordedAtIso: "2026-10-17T12:00:00.000Z",
      processIdentifier: 7,
      agentInstanceIdentifier: "agent-1",
      fields: { residentMemoryBytes: 512 },
      droppedSampleCount: 0,
    });

    const collector = createSessionPerfCollector({
      timerPort,
      samplingPorts: buildSamplingPorts({ store }),
      baseDirectory,
      isCollectionEnabled: true,
      agentInstanceIdentifier: "agent-1",
    });
    collector.start();
    const stopOutcome = await collector.stop();
    expect(stopOutcome.retention?.kind).toBe("rewritten");
    expect((await store.readWithIntegrity()).samples).toHaveLength(0);
  });});



