/**
 * 进程样本落盘（2026-10-19 R51，用户 2026-10-19 决策：**独立事件类型 + 独立文件**）。
 *
 * ## 为什么不复用 `PerfSampleEvent`
 *
 * 既有 PERF 样本是**业务样本**：必填 `operationKind` + `durationMilliseconds`。
 * 进程样本（RSS / 事件循环延迟 / 队列深度）**没有"耗时"**语义，硬填 `0` 就违反卡内的
 * "**unknown 不记作零**"。因此这里新增：
 * - `eventType: "process"`；
 * - 独立文件 `perf/process-samples.jsonl`（与业务样本 `perf/samples.jsonl` 分开，
 *   避免污染既有聚合/分页/告警的计算口径）；
 * - 指标**全部可选**：拿不到就**不写该字段**。
 *
 * ## 边界
 * - 只读/追加，不删除历史（保留策略由上层按 10MB/24h 预算执行）；
 * - 坏行**计数**而不是静默丢弃（`discardedLineCount`），坏行内容不进入样本数组；
 * - 不写原始命令/路径/凭据（只写数值指标与个体标识）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** 进程样本指标（白名单；全部可选）。 */
export interface ProcessSampleFields {
  readonly residentMemoryBytes?: number;
  readonly eventLoopDelayMs?: number;
  readonly taskDurationMs?: number;
  readonly queueDepth?: number;
}

/** 一条进程样本。 */
export interface ProcessSampleEventV1 {
  readonly observeEventVersion: 1;
  readonly eventType: "process";
  readonly recordedAtIso: string;
  readonly processIdentifier: number;
  readonly agentInstanceIdentifier: string | null;
  readonly fields: ProcessSampleFields;
  /** 之前因观测降级而丢失的样本累计数（不静默丢样）。 */
  readonly droppedSampleCount: number;
}

/** 读取结果：坏行必须如实计数。 */
export interface ProcessSampleIntegrityReport {
  readonly samples: ProcessSampleEventV1[];
  readonly discardedLineCount: number;
}

const ALLOWED_FIELD_NAMES = new Set([
  "residentMemoryBytes",
  "eventLoopDelayMs",
  "taskDurationMs",
  "queueDepth",
]);

/** 校验一条进程样本（未知字段/非法数值一律拒绝）。 */
export function isProcessSampleEvent(value: unknown): value is ProcessSampleEventV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["observeEventVersion"] !== 1 || record["eventType"] !== "process") return false;
  if (typeof record["recordedAtIso"] !== "string" || Number.isNaN(Date.parse(record["recordedAtIso"]))) {
    return false;
  }
  if (!Number.isInteger(record["processIdentifier"]) || (record["processIdentifier"] as number) < 0) {
    return false;
  }
  if (record["agentInstanceIdentifier"] !== null && typeof record["agentInstanceIdentifier"] !== "string") {
    return false;
  }
  if (!Number.isInteger(record["droppedSampleCount"]) || (record["droppedSampleCount"] as number) < 0) {
    return false;
  }
  const fields = record["fields"];
  if (fields === null || typeof fields !== "object") return false;
  for (const [fieldName, fieldValue] of Object.entries(fields as Record<string, unknown>)) {
    if (!ALLOWED_FIELD_NAMES.has(fieldName)) return false;
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) return false;
  }
  return true;
}

/** 进程样本落盘（JSONL，追加式）。 */
export class ProcessSampleStore {
  private readonly filePath: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "perf", "process-samples.jsonl");
  }

  /** 追加一条（父目录不存在则创建）。 */
  async append(sample: ProcessSampleEventV1): Promise<void> {
    if (!isProcessSampleEvent(sample)) {
      throw new Error("拒绝写入非法的进程样本（字段不在白名单或数值非法）");
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(sample)}\n`, "utf8");
  }

  /** 读取全部样本；坏行计数（不静默当零、不静默丢弃）。 */
  async readWithIntegrity(): Promise<ProcessSampleIntegrityReport> {
    let rawText: string;
    try {
      rawText = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { samples: [], discardedLineCount: 0 };
      }
      throw error;
    }
    const samples: ProcessSampleEventV1[] = [];
    let discardedLineCount = 0;
    for (const line of rawText.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        discardedLineCount += 1;
        continue;
      }
      if (!isProcessSampleEvent(parsed)) {
        discardedLineCount += 1;
        continue;
      }
      samples.push(parsed);
    }
    return { samples, discardedLineCount };
  }
}
