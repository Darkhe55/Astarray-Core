/**
 * OBS 采样 tick 的反例（2026-10-19 R39）。
 *
 * 覆盖：默认关闭不采、间隔未到不采、预算耗尽不采、白名单外指标被拒、
 * 拿不到指标时**省略字段而不是填 0**、落盘失败/读指标失败**降级且不阻塞**（丢样计数递增）。
 */
import { describe, expect, it } from "vitest";

import { runPerfSamplingTick, type PerfSamplingPorts } from "../../../packages/core/src/orchestration/observability-sampler.js";

interface RecordedSample {
  sampledAtIso: string;
  processIdentifier: number;
  agentInstanceIdentifier: string | null;
  fields: Record<string, number>;
  droppedSampleCount: number;
}

function buildPorts(overrides: Partial<PerfSamplingPorts> & {
  metrics?: Record<string, number>;
  appended?: RecordedSample[];
  appendFailure?: Error;
  metricsFailure?: Error;
} = {}): PerfSamplingPorts & { appended: RecordedSample[] } {
  const appended = overrides.appended ?? [];
  return {
    appended,
    readProcessMetrics: () => {
      if (overrides.metricsFailure !== undefined) throw overrides.metricsFailure;
      return overrides.metrics ?? { residentMemoryBytes: 1024, queueDepth: 0 };
    },
    readNowIso: overrides.readNowIso ?? (() => "2026-10-19T00:01:00.000Z"),
    readProcessIdentifier: overrides.readProcessIdentifier ?? (() => 4242),
    appendSample: async (sample) => {
      if (overrides.appendFailure !== undefined) throw overrides.appendFailure;
      appended.push(sample as RecordedSample);
    },
  };
}

function baseInput(ports: PerfSamplingPorts, overrides: Record<string, unknown> = {}) {
  return {
    ports,
    isCollectionEnabled: true,
    lastSampleAtIso: null,
    storageBytesUsed: 0,
    agentInstanceIdentifier: "agent-1",
    ...overrides,
  };
}

describe("OBS 采样 tick", () => {
  it("① 默认关闭 ⇒ 不采样（skipped）", async () => {
    const ports = buildPorts();
    const outcome = await runPerfSamplingTick(
      baseInput(ports, { isCollectionEnabled: false }),
    );
    expect(outcome).toMatchObject({ kind: "skipped", reasonCode: "collection-disabled" });
    expect(ports.appended).toHaveLength(0);
  });

  it("② 间隔未到 ⇒ 不采样；到点 ⇒ 采样并落盘一条", async () => {
    const ports = buildPorts({ readNowIso: () => "2026-10-19T00:00:02.000Z" });
    expect(
      await runPerfSamplingTick(
        baseInput(ports, { lastSampleAtIso: "2026-10-19T00:00:00.000Z" }),
      ),
    ).toMatchObject({ kind: "skipped", reasonCode: "interval-not-elapsed" });
    expect(ports.appended).toHaveLength(0);

    const ports2 = buildPorts({ readNowIso: () => "2026-10-19T00:00:06.000Z" });
    const sampled = await runPerfSamplingTick(
      baseInput(ports2, { lastSampleAtIso: "2026-10-19T00:00:00.000Z" }),
    );
    expect(sampled.kind).toBe("sampled");
    expect(ports2.appended).toHaveLength(1);
    expect(ports2.appended[0]?.fields.residentMemoryBytes).toBe(1024);
  });

  it("③ 预算耗尽 ⇒ 不采样", async () => {
    const ports = buildPorts();
    const outcome = await runPerfSamplingTick(
      baseInput(ports, { storageBytesUsed: 10 * 1024 * 1024 }),
    );
    expect(outcome).toMatchObject({ kind: "skipped", reasonCode: "storage-budget-exhausted" });
  });

  it("④ 白名单外指标（OS 级）⇒ 拒绝并降级（丢样 +1），不落盘", async () => {
    const ports = buildPorts({ metrics: { cpuPercent: 42 } });
    const outcome = await runPerfSamplingTick(baseInput(ports, { previousDroppedSampleCount: 3 }));
    expect(outcome).toMatchObject({ kind: "degraded", droppedSampleCount: 4 });
    expect(ports.appended).toHaveLength(0);
  });

  it("⑤ 拿不到某项指标 ⇒ 省略该字段（unknown 不记作零）", async () => {
    const ports = buildPorts({ metrics: { residentMemoryBytes: 2048 } });
    await runPerfSamplingTick(baseInput(ports));
    const sample = ports.appended[0];
    expect(sample?.fields.residentMemoryBytes).toBe(2048);
    expect(Object.hasOwn(sample?.fields ?? {}, "eventLoopDelayMs")).toBe(false);
    expect(Object.hasOwn(sample?.fields ?? {}, "queueDepth")).toBe(false);
  });

  it("⑥ 读指标抛错 ⇒ 降级（不抛给调用方），丢样计数递增", async () => {
    const ports = buildPorts({ metricsFailure: new Error("metrics unavailable") });
    const outcome = await runPerfSamplingTick(
      baseInput(ports, { previousDroppedSampleCount: 1 }),
    );
    expect(outcome.kind).toBe("degraded");
    expect(outcome.droppedSampleCount).toBe(2);
    if (outcome.kind !== "degraded") throw new Error("应降级");
    expect(outcome.reason).toContain("不阻塞业务");
  });

  it("⑦ 落盘失败 ⇒ 降级（不抛给调用方），丢样计数递增", async () => {
    const ports = buildPorts({ appendFailure: new Error("disk full") });
    const outcome = await runPerfSamplingTick(baseInput(ports));
    expect(outcome.kind).toBe("degraded");
    expect(outcome.droppedSampleCount).toBe(1);
    if (outcome.kind !== "degraded") throw new Error("应降级");
    expect(outcome.reason).toContain("落盘失败");
  });

  it("⑧ 任务事实（耗时/队列）与进程指标合并，且仍走白名单", async () => {
    const ports = buildPorts();
    await runPerfSamplingTick(
      baseInput(ports, { taskFacts: { taskDurationMs: 120, queueDepth: 3 } }),
    );
    const sample = ports.appended[0];
    expect(sample?.fields.taskDurationMs).toBe(120);
    expect(sample?.fields.queueDepth).toBe(3);
    expect(sample?.agentInstanceIdentifier).toBe("agent-1");
    expect(sample?.processIdentifier).toBe(4242);
  });
});
