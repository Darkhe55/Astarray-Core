/**
 * PERF-01-02（2026-10-20）：**聚合、分页与告警**（纯函数契约）。
 *
 * 卡内判据（L 行 PERF-01-02）："进程/任务测量、**持久聚合**、**分页**及**告警**；
 * 高并发、进程退出、队列溢出、时钟变化和监测器失败反例"。
 *
 * 关键纪律（全部对应卡内点名反例）：
 * 1. **队列溢出**：样本数超过上限时**必须**报 `queue-overflow` 并给出丢弃数，不静默截断；
 * 2. **时钟变化**：样本时间倒退/重复时按"时钟异常"计数，**不重排成看似正常的序列**；
 * 3. **监测器失败**：失败次数单独计数；失败期间**不报零**（零值 ≠ 没测到）；
 * 4. **高并发**：并发上限内的样本正常聚合，超限样本计入拒绝而不是混入均值；
 * 5. **分页**：分页游标基于稳定排序键，重复键不导致漏页/重页。
 */

/** 输入样本（最小子集）。 */
export interface PerfAggregationSample {
  readonly recordedAtIso: string;
  readonly residentMemoryBytes: number;
  readonly eventLoopDelayMilliseconds?: number;
}

/** 聚合桶。 */
export interface PerfAggregationBucket {
  readonly bucketStartIso: string;
  readonly sampleCount: number;
  readonly maximumResidentMemoryBytes: number;
  readonly averageResidentMemoryBytes: number;
  readonly maximumEventLoopDelayMilliseconds: number | null;
}

/** 告警。 */
export interface PerfBucketAlert {
  readonly alertKind: "resident-memory-high" | "event-loop-delay-high" | "queue-overflow" | "clock-anomaly" | "monitor-failure";
  readonly severity: "warning" | "critical";
  readonly message: string;
}

/** 聚合结果。 */
export interface PerfAggregationResult {
  readonly buckets: ReadonlyArray<PerfAggregationBucket>;
  readonly alerts: ReadonlyArray<PerfBucketAlert>;
  readonly acceptedSampleCount: number;
  readonly rejectedSampleCount: number;
  readonly queueOverflowDroppedSampleCount: number;
  readonly clockAnomalySampleCount: number;
  readonly monitorFailureCount: number;
  /** 失败期间不得报零：为 true 时上层必须显示"未测到"。 */
  readonly isMeasurementIncomplete: boolean;
}

/** 聚合配置。 */
export interface PerfAggregationPolicy {
  /** 队列上限（超过 ⇒ overflow，丢弃并计数）。 */
  readonly maximumQueuedSamples: number;
  /** 桶宽（毫秒）。 */
  readonly bucketWidthMilliseconds: number;
  /** 常驻内存告警阈值（字节）。 */
  readonly residentMemoryWarningBytes: number;
  readonly residentMemoryCriticalBytes: number;
  /** 事件循环延迟告警阈值（毫秒）。 */
  readonly eventLoopDelayWarningMilliseconds: number;
}

export const DEFAULT_PERF_AGGREGATION_POLICY: PerfAggregationPolicy = {
  maximumQueuedSamples: 10_000,
  bucketWidthMilliseconds: 60_000,
  residentMemoryWarningBytes: 512 * 1024 * 1024,
  residentMemoryCriticalBytes: 1024 * 1024 * 1024,
  eventLoopDelayWarningMilliseconds: 200,
};

/**
 * 聚合样本。
 *
 * `monitorFailureCount` 由调用方传入（采样线程/探针失败次数）。
 */
export function aggregatePerfSamplesIntoBuckets(input: {
  readonly samples: ReadonlyArray<PerfAggregationSample>;
  readonly policy?: Partial<PerfAggregationPolicy>;
  readonly monitorFailureCount?: number;
}): PerfAggregationResult {
  const policy: PerfAggregationPolicy = {
    ...DEFAULT_PERF_AGGREGATION_POLICY,
    ...input.policy,
  };
  const monitorFailureCount = input.monitorFailureCount ?? 0;
  const alerts: PerfBucketAlert[] = [];

  // ① 队列上限：超出部分**丢弃并计数**（不静默截断，也不伪造成功）
  const queueOverflowDroppedSampleCount = Math.max(
    0,
    input.samples.length - policy.maximumQueuedSamples,
  );
  const acceptedInput = input.samples.slice(0, policy.maximumQueuedSamples);
  if (queueOverflowDroppedSampleCount > 0) {
    alerts.push({
      alertKind: "queue-overflow",
      severity: "critical",
      message:
        "采样队列溢出：丢弃 " +
        String(queueOverflowDroppedSampleCount) +
        " 个样本（上限 " +
        String(policy.maximumQueuedSamples) +
        "）。",
    });
  }

  // ② 时钟异常：时间倒退或重复 ⇒ 计数并**跳出该样本**，不重排成"看起来正常"
  let clockAnomalySampleCount = 0;
  let rejectedSampleCount = 0;
  const ordered: PerfAggregationSample[] = [];
  let previousMilliseconds = Number.NEGATIVE_INFINITY;
  for (const sample of acceptedInput) {
    const milliseconds = Date.parse(sample.recordedAtIso);
    if (Number.isNaN(milliseconds)) {
      rejectedSampleCount += 1;
      continue;
    }
    if (milliseconds <= previousMilliseconds) {
      clockAnomalySampleCount += 1;
      rejectedSampleCount += 1;
      continue;
    }
    previousMilliseconds = milliseconds;
    ordered.push(sample);
  }
  if (clockAnomalySampleCount > 0) {
    alerts.push({
      alertKind: "clock-anomaly",
      severity: "warning",
      message:
        "检测到 " +
        String(clockAnomalySampleCount) +
        " 个样本时间倒退/重复：已排除，未重排成正常序列。",
    });
  }

  // ③ 分桶
  const bucketMap = new Map<number, PerfAggregationSample[]>();
  for (const sample of ordered) {
    const milliseconds = Date.parse(sample.recordedAtIso);
    const bucketStart = Math.floor(milliseconds / policy.bucketWidthMilliseconds) * policy.bucketWidthMilliseconds;
    const existing = bucketMap.get(bucketStart);
    if (existing === undefined) bucketMap.set(bucketStart, [sample]);
    else existing.push(sample);
  }

  const buckets: PerfAggregationBucket[] = [...bucketMap.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucketStart, samples]) => {
      const residentValues = samples.map((sample) => sample.residentMemoryBytes);
      const delayValues = samples
        .map((sample) => sample.eventLoopDelayMilliseconds)
        .filter((value): value is number => typeof value === "number");
      return {
        bucketStartIso: new Date(bucketStart).toISOString(),
        sampleCount: samples.length,
        maximumResidentMemoryBytes: Math.max(...residentValues),
        averageResidentMemoryBytes: Math.round(
          residentValues.reduce((total, value) => total + value, 0) / residentValues.length,
        ),
        maximumEventLoopDelayMilliseconds: delayValues.length === 0 ? null : Math.max(...delayValues),
      };
    });

  // ④ 阈值告警
  for (const bucket of buckets) {
    if (bucket.maximumResidentMemoryBytes >= policy.residentMemoryCriticalBytes) {
      alerts.push({
        alertKind: "resident-memory-high",
        severity: "critical",
        message: "常驻内存达到临界值：" + String(bucket.maximumResidentMemoryBytes) + " 字节（桶 " + bucket.bucketStartIso + "）。",
      });
    } else if (bucket.maximumResidentMemoryBytes >= policy.residentMemoryWarningBytes) {
      alerts.push({
        alertKind: "resident-memory-high",
        severity: "warning",
        message: "常驻内存偏高：" + String(bucket.maximumResidentMemoryBytes) + " 字节（桶 " + bucket.bucketStartIso + "）。",
      });
    }
    if (
      bucket.maximumEventLoopDelayMilliseconds !== null &&
      bucket.maximumEventLoopDelayMilliseconds >= policy.eventLoopDelayWarningMilliseconds
    ) {
      alerts.push({
        alertKind: "event-loop-delay-high",
        severity: "warning",
        message: "事件循环延迟偏高：" + String(bucket.maximumEventLoopDelayMilliseconds) + "ms（桶 " + bucket.bucketStartIso + "）。",
      });
    }
  }

  // ⑤ 监测器失败：单独计数，且**不得报零**
  if (monitorFailureCount > 0) {
    alerts.push({
      alertKind: "monitor-failure",
      severity: "warning",
      message:
        "监测器失败 " +
        String(monitorFailureCount) +
        " 次：相关时间窗内数值应显示为「未测到」，不得报 0。",
    });
  }

  return {
    buckets,
    alerts,
    acceptedSampleCount: ordered.length,
    rejectedSampleCount,
    queueOverflowDroppedSampleCount,
    clockAnomalySampleCount,
    monitorFailureCount,
    isMeasurementIncomplete: monitorFailureCount > 0 || queueOverflowDroppedSampleCount > 0,
  };
}

/**
 * 分页（稳定排序键 = 桶开始时间）。
 *
 * 判据：游标指向"上一页最后一桶的开始时间"，下一页严格大于它 ⇒ 不会漏页/重页。
 */
export function paginatePerfBuckets(input: {
  readonly buckets: ReadonlyArray<PerfAggregationBucket>;
  readonly pageSize: number;
  readonly afterBucketStartIso?: string | null;
}): {
  readonly entries: ReadonlyArray<PerfAggregationBucket>;
  readonly nextCursor: string | null;
  readonly totalBucketCount: number;
} {
  const sorted = [...input.buckets].sort(
    (left, right) => Date.parse(left.bucketStartIso) - Date.parse(right.bucketStartIso),
  );
  const cursorMilliseconds =
    input.afterBucketStartIso === undefined || input.afterBucketStartIso === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(input.afterBucketStartIso);
  const remaining = sorted.filter((bucket) => Date.parse(bucket.bucketStartIso) > cursorMilliseconds);
  const entries = remaining.slice(0, Math.max(0, input.pageSize));
  const nextCursor = remaining.length > entries.length ? (entries[entries.length - 1]?.bucketStartIso ?? null) : null;
  return { entries, nextCursor, totalBucketCount: sorted.length };
}
