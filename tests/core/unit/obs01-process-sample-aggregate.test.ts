/**
 * 进程样本聚合的反例（2026-10-19 R58）。
 *
 * 重点：**unknown 不记作零** —— 缺字段的样本不计入该字段分母，且全缺时统计为 null。
 */
import { describe, expect, it } from "vitest";

import { aggregateProcessSamples } from "../../../packages/core/src/orchestration/process-sample-aggregate.js";
import type { ProcessSampleEventV1 } from "../../../packages/core/src/orchestration/process-sample-store.js";

function sample(
  recordedAtIso: string,
  fields: ProcessSampleEventV1["fields"],
  droppedSampleCount = 0,
): ProcessSampleEventV1 {
  return {
    observeEventVersion: 1,
    eventType: "process",
    recordedAtIso,
    processIdentifier: 1,
    agentInstanceIdentifier: "agent-1",
    fields,
    droppedSampleCount,
  };
}

describe("进程样本聚合", () => {
  it("① 缺字段的样本不计入该字段分母（unknown 不记作零）", () => {
    const aggregate = aggregateProcessSamples({
      samples: [
        sample("2026-10-19T00:00:00.000Z", { residentMemoryBytes: 100 }),
        sample("2026-10-19T00:00:05.000Z", { residentMemoryBytes: 300, queueDepth: 0 }),
      ],
    });
    expect(aggregate.sampleCount).toBe(2);
    expect(aggregate.fields.residentMemoryBytes.sampleCount).toBe(2);
    expect(aggregate.fields.residentMemoryBytes.mean).toBe(200);
    // queueDepth 只有 1 条有值 ⇒ 分母是 1，不是 2
    expect(aggregate.fields.queueDepth.sampleCount).toBe(1);
    expect(aggregate.fields.queueDepth.mean).toBe(0);
    // 完全没出现的字段 ⇒ null（不可报告），绝不是 0
    expect(aggregate.fields.eventLoopDelayMs.sampleCount).toBe(0);
    expect(aggregate.fields.eventLoopDelayMs.mean).toBeNull();
    expect(aggregate.fields.taskDurationMs.median).toBeNull();
  });

  it("② min/max/mean/median 计算正确（偶数个中位数取中间两数均值）", () => {
    const aggregate = aggregateProcessSamples({
      samples: [
        sample("2026-10-19T00:00:00.000Z", { taskDurationMs: 10 }),
        sample("2026-10-19T00:00:01.000Z", { taskDurationMs: 20 }),
        sample("2026-10-19T00:00:02.000Z", { taskDurationMs: 30 }),
        sample("2026-10-19T00:00:03.000Z", { taskDurationMs: 100 }),
      ],
    });
    const statistics = aggregate.fields.taskDurationMs;
    expect(statistics.minimum).toBe(10);
    expect(statistics.maximum).toBe(100);
    expect(statistics.mean).toBe(40);
    expect(statistics.median).toBe(25);
  });

  it("③ 覆盖窗口按真实时间取最早/最晚（乱序输入也一样）", () => {
    const aggregate = aggregateProcessSamples({
      samples: [
        sample("2026-10-19T00:00:30.000Z", {}),
        sample("2026-10-19T00:00:10.000Z", {}),
        sample("2026-10-19T00:00:20.000Z", {}),
      ],
    });
    expect(aggregate.earliestRecordedAtIso).toBe("2026-10-19T00:00:10.000Z");
    expect(aggregate.latestRecordedAtIso).toBe("2026-10-19T00:00:30.000Z");
  });

  it("④ 丢弃行数与丢样累计如实回传", () => {
    const aggregate = aggregateProcessSamples({
      samples: [
        sample("2026-10-19T00:00:00.000Z", { residentMemoryBytes: 1 }, 2),
        sample("2026-10-19T00:00:01.000Z", { residentMemoryBytes: 2 }, 3),
      ],
      discardedLineCount: 4,
    });
    expect(aggregate.discardedLineCount).toBe(4);
    expect(aggregate.droppedSampleCountTotal).toBe(5);
  });

  it("⑤ 空输入 ⇒ 全 null 且计数为 0（不是报错，也不是 0 值统计）", () => {
    const aggregate = aggregateProcessSamples({ samples: [] });
    expect(aggregate.sampleCount).toBe(0);
    expect(aggregate.earliestRecordedAtIso).toBeNull();
    expect(aggregate.latestRecordedAtIso).toBeNull();
    expect(aggregate.fields.residentMemoryBytes.sampleCount).toBe(0);
    expect(aggregate.fields.residentMemoryBytes.minimum).toBeNull();
  });

  it("⑥ 单值 ⇒ min=max=mean=median（分母为 1 也如实给出）", () => {
    const aggregate = aggregateProcessSamples({
      samples: [sample("2026-10-19T00:00:00.000Z", { eventLoopDelayMs: 7 })],
    });
    const statistics = aggregate.fields.eventLoopDelayMs;
    expect(statistics.sampleCount).toBe(1);
    expect(statistics.minimum).toBe(7);
    expect(statistics.maximum).toBe(7);
    expect(statistics.mean).toBe(7);
    expect(statistics.median).toBe(7);
  });
});
