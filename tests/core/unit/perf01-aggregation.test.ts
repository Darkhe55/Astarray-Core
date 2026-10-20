/**
 * PERF-01-02 反例（2026-10-20）：队列溢出、时钟变化、监测器失败、阈值告警、分页稳定。
 */
import { describe, expect, it } from "vitest";

import {
  aggregatePerfSamplesIntoBuckets,
  paginatePerfBuckets,
  type PerfAggregationSample,
} from "../../../packages/core/src/orchestration/perf-aggregation.js";

function sample(recordedAtIso: string, residentMemoryBytes = 100, eventLoopDelayMilliseconds?: number): PerfAggregationSample {
  return {
    recordedAtIso,
    residentMemoryBytes,
    ...(eventLoopDelayMilliseconds === undefined ? {} : { eventLoopDelayMilliseconds }),
  };
}

describe("PERF-01-02 聚合与告警", () => {
  it("① 正常样本按桶聚合，均值/峰值正确", () => {
    const result = aggregatePerfSamplesIntoBuckets({
      samples: [sample("2026-10-20T10:00:01.000Z", 100), sample("2026-10-20T10:00:30.000Z", 300)],
      policy: { bucketWidthMilliseconds: 60_000 },
    });
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      sampleCount: 2,
      maximumResidentMemoryBytes: 300,
      averageResidentMemoryBytes: 200,
    });
  });

  it("② 队列溢出 ⇒ 丢弃并计数 + critical 告警（不静默截断）", () => {
    const samples = Array.from({ length: 5 }, (_value, index) =>
      sample(`2026-10-20T10:00:0${String(index)}.000Z`, 100),
    );
    const result = aggregatePerfSamplesIntoBuckets({ samples, policy: { maximumQueuedSamples: 3 } });
    expect(result.queueOverflowDroppedSampleCount).toBe(2);
    expect(result.acceptedSampleCount).toBe(3);
    expect(result.isMeasurementIncomplete).toBe(true);
    expect(result.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ alertKind: "queue-overflow", severity: "critical" })]),
    );
  });

  it("③ 时钟倒退 ⇒ 计入 clockAnomaly 并排除该样本（不重排成正常序列）", () => {
    const result = aggregatePerfSamplesIntoBuckets({
      samples: [
        sample("2026-10-20T10:00:10.000Z", 100),
        sample("2026-10-20T10:00:05.000Z", 900), // 倒退
      ],
    });
    expect(result.clockAnomalySampleCount).toBe(1);
    expect(result.rejectedSampleCount).toBe(1);
    expect(result.acceptedSampleCount).toBe(1);
    expect(result.buckets[0]?.maximumResidentMemoryBytes).toBe(100);
    expect(result.alerts.some((alert) => alert.alertKind === "clock-anomaly")).toBe(true);
  });

  it("④ 重复时间戳 ⇒ 同样视为时钟异常（不允许并列）", () => {
    const result = aggregatePerfSamplesIntoBuckets({
      samples: [sample("2026-10-20T10:00:10.000Z"), sample("2026-10-20T10:00:10.000Z")],
    });
    expect(result.clockAnomalySampleCount).toBe(1);
  });

  it("⑤ 监测器失败 ⇒ 单独计数 + 告警 + isMeasurementIncomplete（不报零）", () => {
    const result = aggregatePerfSamplesIntoBuckets({
      samples: [sample("2026-10-20T10:00:01.000Z", 100)],
      monitorFailureCount: 2,
    });
    expect(result.monitorFailureCount).toBe(2);
    expect(result.isMeasurementIncomplete).toBe(true);
    const alert = result.alerts.find((entry) => entry.alertKind === "monitor-failure");
    expect(alert?.message).toContain("未测到");
  });

  it("⑥ 无样本 + 无失败 ⇒ 空桶且不谎报未测到", () => {
    const result = aggregatePerfSamplesIntoBuckets({ samples: [] });
    expect(result.buckets).toHaveLength(0);
    expect(result.isMeasurementIncomplete).toBe(false);
    expect(result.alerts).toHaveLength(0);
  });

  it("⑦ 内存临界阈值 ⇒ critical；警告阈值 ⇒ warning", () => {
    const critical = aggregatePerfSamplesIntoBuckets({
      samples: [sample("2026-10-20T10:00:01.000Z", 2 * 1024 * 1024 * 1024)],
    });
    expect(critical.alerts.some((alert) => alert.alertKind === "resident-memory-high" && alert.severity === "critical")).toBe(true);

    const warning = aggregatePerfSamplesIntoBuckets({
      samples: [sample("2026-10-20T10:00:01.000Z", 600 * 1024 * 1024)],
    });
    expect(warning.alerts.some((alert) => alert.alertKind === "resident-memory-high" && alert.severity === "warning")).toBe(true);
  });

  it("⑧ 事件循环延迟阈值告警；无延迟样本 ⇒ null 而不是 0", () => {
    const withDelay = aggregatePerfSamplesIntoBuckets({
      samples: [sample("2026-10-20T10:00:01.000Z", 100, 500)],
    });
    expect(withDelay.alerts.some((alert) => alert.alertKind === "event-loop-delay-high")).toBe(true);
    expect(withDelay.buckets[0]?.maximumEventLoopDelayMilliseconds).toBe(500);

    const withoutDelay = aggregatePerfSamplesIntoBuckets({ samples: [sample("2026-10-20T10:00:01.000Z", 100)] });
    expect(withoutDelay.buckets[0]?.maximumEventLoopDelayMilliseconds).toBeNull();
  });

  it("⑨ 非法时间戳 ⇒ 计入 rejected（不参与聚合）", () => {
    const result = aggregatePerfSamplesIntoBuckets({ samples: [sample("not-a-date")] });
    expect(result.rejectedSampleCount).toBe(1);
    expect(result.acceptedSampleCount).toBe(0);
  });

  it("⑩ 分页：游标严格大于上一页最后一桶 ⇒ 不漏页不重页", () => {
    const samples = Array.from({ length: 5 }, (_value, index) =>
      sample(`2026-10-20T10:0${String(index)}:00.000Z`, 100),
    );
    const aggregated = aggregatePerfSamplesIntoBuckets({ samples, policy: { bucketWidthMilliseconds: 60_000 } });
    const firstPage = paginatePerfBuckets({ buckets: aggregated.buckets, pageSize: 2 });
    expect(firstPage.entries).toHaveLength(2);
    const secondPage = paginatePerfBuckets({
      buckets: aggregated.buckets,
      pageSize: 2,
      afterBucketStartIso: firstPage.nextCursor,
    });
    expect(secondPage.entries).toHaveLength(2);
    const firstPageStarts = firstPage.entries.map((bucket) => bucket.bucketStartIso);
    expect(secondPage.entries.some((bucket) => firstPageStarts.includes(bucket.bucketStartIso))).toBe(false);
    expect(firstPage.totalBucketCount).toBe(5);
  });

  it("⑪ 分页到末尾 ⇒ nextCursor 为 null", () => {
    const aggregated = aggregatePerfSamplesIntoBuckets({
      samples: [sample("2026-10-20T10:00:01.000Z")],
    });
    const page = paginatePerfBuckets({ buckets: aggregated.buckets, pageSize: 10 });
    expect(page.nextCursor).toBeNull();
  });

  it("⑫ 高并发（大量样本）不改变单桶语义，且计数可核对", () => {
    const samples = Array.from({ length: 500 }, (_value, index) =>
      sample(new Date(Date.UTC(2026, 9, 20, 10, 0, 0) + index * 100).toISOString(), 100 + index),
    );
    const result = aggregatePerfSamplesIntoBuckets({ samples, policy: { maximumQueuedSamples: 1000 } });
    expect(result.acceptedSampleCount).toBe(500);
    const totalInBuckets = result.buckets.reduce((total, bucket) => total + bucket.sampleCount, 0);
    expect(totalInBuckets).toBe(500);
  });
});
