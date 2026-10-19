/**
 * 进程样本聚合（2026-10-19 R58）：供 `obs process --summary` 与报告使用。
 *
 * 卡内约束："**unknown 不记作零**"、"样本窗口与覆盖范围必须显示"。
 * 因此聚合纪律：
 * 1. **逐字段统计**：某样本缺该字段 ⇒ 该字段的样本数减少，**不把它当 0**；
 * 2. **每个字段都报告 `sampleCount`**，让读的人知道分母是多少；
 * 3. 全部缺失 ⇒ 该字段为 `null`（"不可报告"），而不是 0；
 * 4. 同时回传覆盖窗口（最早/最晚样本时间）与丢弃行数、丢样累计。
 */
import type { ProcessSampleEventV1, ProcessSampleFields } from "./process-sample-store.js";

/** 单字段统计。 */
export interface ProcessSampleFieldStatistics {
  /** 参与统计的样本数（分母）。 */
  readonly sampleCount: number;
  /** 全部缺失时为 null（不可报告，不是 0）。 */
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly mean: number | null;
  /** 中位数（偶数个时取中间两数均值）。 */
  readonly median: number | null;
}

/** 聚合结果。 */
export interface ProcessSampleAggregate {
  readonly sampleCount: number;
  readonly discardedLineCount: number;
  readonly droppedSampleCountTotal: number;
  /** 覆盖窗口（无样本时两者皆 null）。 */
  readonly earliestRecordedAtIso: string | null;
  readonly latestRecordedAtIso: string | null;
  readonly fields: Readonly<Record<keyof ProcessSampleFields, ProcessSampleFieldStatistics>>;
}

const FIELD_NAMES: ReadonlyArray<keyof ProcessSampleFields> = [
  "residentMemoryBytes",
  "eventLoopDelayMs",
  "taskDurationMs",
  "queueDepth",
];

function summarizeField(values: ReadonlyArray<number>): ProcessSampleFieldStatistics {
  if (values.length === 0) {
    return { sampleCount: 0, minimum: null, maximum: null, mean: null, median: null };
  }
  const sortedValues = [...values].sort((left, right) => left - right);
  const total = sortedValues.reduce((sum, value) => sum + value, 0);
  const middleIndex = Math.floor(sortedValues.length / 2);
  const median =
    sortedValues.length % 2 === 1
      ? (sortedValues[middleIndex] ?? 0)
      : ((sortedValues[middleIndex - 1] ?? 0) + (sortedValues[middleIndex] ?? 0)) / 2;
  return {
    sampleCount: sortedValues.length,
    minimum: sortedValues[0] ?? null,
    maximum: sortedValues[sortedValues.length - 1] ?? null,
    mean: total / sortedValues.length,
    median,
  };
}

/** 聚合进程样本（纯函数）。 */
export function aggregateProcessSamples(input: {
  readonly samples: ReadonlyArray<ProcessSampleEventV1>;
  readonly discardedLineCount?: number;
}): ProcessSampleAggregate {
  const fieldValues: Record<keyof ProcessSampleFields, number[]> = {
    residentMemoryBytes: [],
    eventLoopDelayMs: [],
    taskDurationMs: [],
    queueDepth: [],
  };
  let droppedSampleCountTotal = 0;
  let earliestRecordedAtIso: string | null = null;
  let latestRecordedAtIso: string | null = null;

  for (const sample of input.samples) {
    droppedSampleCountTotal += sample.droppedSampleCount;
    const recordedAtMilliseconds = Date.parse(sample.recordedAtIso);
    if (!Number.isNaN(recordedAtMilliseconds)) {
      if (
        earliestRecordedAtIso === null ||
        recordedAtMilliseconds < Date.parse(earliestRecordedAtIso)
      ) {
        earliestRecordedAtIso = sample.recordedAtIso;
      }
      if (
        latestRecordedAtIso === null ||
        recordedAtMilliseconds > Date.parse(latestRecordedAtIso)
      ) {
        latestRecordedAtIso = sample.recordedAtIso;
      }
    }
    for (const fieldName of FIELD_NAMES) {
      const value = sample.fields[fieldName];
      // **关键**：缺失字段不参与统计（不补 0）
      if (value === undefined) continue;
      fieldValues[fieldName].push(value);
    }
  }

  return {
    sampleCount: input.samples.length,
    discardedLineCount: input.discardedLineCount ?? 0,
    droppedSampleCountTotal,
    earliestRecordedAtIso,
    latestRecordedAtIso,
    fields: {
      residentMemoryBytes: summarizeField(fieldValues.residentMemoryBytes),
      eventLoopDelayMs: summarizeField(fieldValues.eventLoopDelayMs),
      taskDurationMs: summarizeField(fieldValues.taskDurationMs),
      queueDepth: summarizeField(fieldValues.queueDepth),
    },
  };
}
