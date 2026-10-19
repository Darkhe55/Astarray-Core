/**
 * 进程样本保留策略的**执行**（2026-10-19 R54）：判定 → 备份 → 原子重写。
 *
 * 卡内约束（OBS-01 §2）："归档、压缩替换和清理遵循**自动备份**及专用删除规则"、
 * "存储预算耗尽时先停可选详细采集并报告，**不静默删除历史**"。
 *
 * 因此本模块的执行纪律：
 * 1. **先备份**原文件（`process-samples.backup-<时间戳>.jsonl`）再重写；备份失败 ⇒ **放弃重写**；
 * 2. 重写用 `临时文件 + rename`（原子），失败不留下半截文件；
 * 3. 坏行（无法解析/非法）不参与保留计算，但**丢弃行数如实回传**；
 * 4. 无需裁剪时**不动文件**（避免无谓写入与 mtime 抖动）。
 */
import path from "node:path";

import { copyFileWithBackup, writeAtomicTextFile } from "../infra/atomic-json.js";

import {
  planProcessSampleRetention,
  type ProcessSampleRetentionPlan,
} from "./process-sample-retention.js";
import { ProcessSampleStore, type ProcessSampleEventV1 } from "./process-sample-store.js";

/** 执行结果。 */
export interface ProcessSampleRetentionApplyReport {
  readonly kind: "no-action" | "rewritten" | "abandoned";
  readonly plan: ProcessSampleRetentionPlan;
  readonly retainedSampleCount: number;
  readonly discardedLineCount: number;
  readonly backupFilePath: string | null;
  readonly reason: string;
}

/**
 * 按保留策略重写进程样本文件。
 *
 * @returns `kind: "abandoned"` 表示备份或重写失败 —— **文件保持原样**（不静默丢历史）。
 */
export async function applyProcessSampleRetention(input: {
  readonly baseDirectory: string;
  readonly nowIso: string;
  readonly budgetBytes?: number;
  readonly retentionHours?: number;
}): Promise<ProcessSampleRetentionApplyReport> {
  const store = new ProcessSampleStore({ baseDirectory: input.baseDirectory });
  const filePath = path.join(input.baseDirectory, "perf", "process-samples.jsonl");

  const report = await store.readWithIntegrity();
  const candidates = report.samples.map((sample) => ({
    sample,
    recordedAtIso: sample.recordedAtIso,
    serializedBytes: Buffer.byteLength(`${JSON.stringify(sample)}\n`, "utf8"),
  }));
  const plan = planProcessSampleRetention({
    samples: candidates.map((candidate) => ({
      recordedAtIso: candidate.recordedAtIso,
      serializedBytes: candidate.serializedBytes,
    })),
    nowIso: input.nowIso,
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.retentionHours === undefined ? {} : { retentionHours: input.retentionHours }),
  });

  if (plan.kind === "no-action") {
    return {
      kind: "no-action",
      plan,
      retainedSampleCount: report.samples.length,
      discardedLineCount: report.discardedLineCount,
      backupFilePath: null,
      reason: "无需裁剪：文件保持原样。",
    };
  }

  // 按计划保留"从新往回、仍在保留期且不超预算"的样本（与 plan 的判定完全同源）
  const retainedSamples = selectRetainedSamples({
    candidates: candidates.map((candidate) => candidate.sample),
    nowIso: input.nowIso,
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.retentionHours === undefined ? {} : { retentionHours: input.retentionHours }),
  });

  const backupFilePath = [
    input.baseDirectory,
    "perf",
    `process-samples.backup-${input.nowIso.replaceAll(":", "-")}.jsonl`,
  ].join("/");
  try {
    // ① 先备份（失败即放弃重写；备份是"清理前必须备份"的硬要求）
    await copyFileWithBackup(filePath, backupFilePath);
    // ② 原子重写（temp → fsync → rename，都在白名单模块内）
    await writeAtomicTextFile(
      filePath,
      retainedSamples.map((sample) => `${JSON.stringify(sample)}\n`).join(""),
    );
  } catch (error) {
    return {
      kind: "abandoned",
      plan,
      retainedSampleCount: report.samples.length,
      discardedLineCount: report.discardedLineCount,
      backupFilePath: null,
      reason: `备份或重写失败，文件保持原样：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    kind: "rewritten",
    plan,
    retainedSampleCount: retainedSamples.length,
    discardedLineCount: report.discardedLineCount,
    backupFilePath,
    reason: plan.reason,
  };
}

/**
 * 与 `planProcessSampleRetention` **同源**的保留选择（避免两处规则漂移）。
 *
 * 注意：这里重复了一遍"从新往回"的循环，但**判据与 plan 完全一致**；
 * 之所以不把选择结果塞进 plan，是为了保持 plan 为纯数据（可 JSON 存档）。
 */
function selectRetainedSamples(input: {
  readonly candidates: ReadonlyArray<ProcessSampleEventV1>;
  readonly nowIso: string;
  readonly budgetBytes?: number;
  readonly retentionHours?: number;
}): ProcessSampleEventV1[] {
  const plan = planProcessSampleRetention({
    samples: input.candidates.map((sample) => ({
      recordedAtIso: sample.recordedAtIso,
      serializedBytes: Buffer.byteLength(`${JSON.stringify(sample)}\n`, "utf8"),
    })),
    nowIso: input.nowIso,
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.retentionHours === undefined ? {} : { retentionHours: input.retentionHours }),
  });
  const retentionHours = input.retentionHours ?? 24;
  const boundaryMilliseconds = Date.parse(input.nowIso) - retentionHours * 3_600_000;
  const budgetBytes = input.budgetBytes ?? plan.retainedBytes;
  const retained: ProcessSampleEventV1[] = [];
  let retainedBytes = 0;
  for (let index = input.candidates.length - 1; index >= 0; index -= 1) {
    const sample = input.candidates[index];
    if (sample === undefined) continue;
    const recordedAtMilliseconds = Date.parse(sample.recordedAtIso);
    if (Number.isNaN(recordedAtMilliseconds) || recordedAtMilliseconds < boundaryMilliseconds) {
      continue;
    }
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(sample)}\n`, "utf8");
    if (retainedBytes + serializedBytes <= budgetBytes) {
      retainedBytes += serializedBytes;
      retained.push(sample);
    }
  }
  return retained.reverse();
}
