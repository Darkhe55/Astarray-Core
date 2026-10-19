/**
 * `obs perf rotate`（2026-10-19 R76）：让运维**先看**保留策略会裁掉什么，再决定是否动手。
 *
 * 用户价值：R53/R54 的保留逻辑此前只在"会话结束时"隐式触发；本命令把它变成**显式、可预览**的操作：
 * - 默认 **dry-run**：只报告计划（会裁几条、现在多大、保留窗口），**绝不改盘**；
 * - `--apply` 才真正执行（走 R54 的"先备份 → 原子重写"，备份失败即放弃）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { planProcessSampleRetention } from "../../../core/src/orchestration/process-sample-retention.js";
import { applyProcessSampleRetention } from "../../../core/src/orchestration/process-sample-retention-apply.js";
import { ProcessSampleStore } from "../../../core/src/orchestration/process-sample-store.js";
import { EXIT_CODES, logToStderr, printJson } from "./json-output.js";

/** `obs perf rotate` 输入。 */
export interface ObsPerfRotateCommandInput {
  readonly stateDirectory: string;
  /** 缺省 false：只预览，不改盘。 */
  readonly isApply?: boolean;
  readonly nowIso?: string;
  readonly budgetBytes?: number;
  readonly retentionHours?: number;
  readonly isJsonOutput: boolean;
}

/** 执行 `obs perf rotate`。 */
export async function executeObsPerfRotateCommand(
  input: ObsPerfRotateCommandInput,
): Promise<number> {
  /**
   * **参数校验（R77）**：非法预算/保留时长必须**直接拒绝**，而不是把 NaN 传进计划。
   *
   * 事故模型：`NaN` 预算会让"字节数 ≤ 预算"恒为 false ⇒ **全部样本被判超预算**，
   * 用户只是敲错一个参数，结果历史被裁掉。宁可少做，不可误删。
   */
  for (const [flagName, value] of [
    ["--budget-bytes", input.budgetBytes],
    ["--retention-hours", input.retentionHours],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0) {
      logToStderr(`${flagName} 必须是正的有限数（收到 ${String(value)}）；未修改任何文件。`);
      return EXIT_CODES.FAILURE;
    }
  }

  const nowIso = input.nowIso ?? new Date().toISOString();
  const isApply = input.isApply === true;
  const store = new ProcessSampleStore({ baseDirectory: input.stateDirectory });

  const report = await store.readWithIntegrity();
  const candidates = report.samples.map((sample) => ({
    recordedAtIso: sample.recordedAtIso,
    serializedBytes: Buffer.byteLength(`${JSON.stringify(sample)}\n`, "utf8"),
  }));
  const plan = planProcessSampleRetention({
    samples: candidates,
    nowIso,
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.retentionHours === undefined ? {} : { retentionHours: input.retentionHours }),
  });

  if (!isApply) {
    // **dry-run：绝不改盘**（连备份都不写）
    const payload = {
      kind: "preview" as const,
      isApply: false,
      plan,
      discardedLineCount: report.discardedLineCount,
      backupFilePath: null,
      notice: "这是预览：未修改任何文件。确认后加 --apply 执行（会先备份再原子重写）。",
    };
    if (input.isJsonOutput) {
      printJson(payload);
    } else {
      process.stdout.write(
        [
          `保留策略预览（${nowIso}）`,
          `样本数：${String(candidates.length)}；丢弃行：${String(report.discardedLineCount)}`,
          `判定：${plan.kind} —— ${plan.reason}`,
          "未修改任何文件；加 --apply 才会执行。",
          "",
        ].join("\n"),
      );
    }
    return EXIT_CODES.SUCCESS;
  }

  const applyReport = await applyProcessSampleRetention({
    baseDirectory: input.stateDirectory,
    nowIso,
    ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
    ...(input.retentionHours === undefined ? {} : { retentionHours: input.retentionHours }),
  });
  const payload = {
    kind: "applied" as const,
    isApply: true,
    plan: applyReport.plan,
    applyKind: applyReport.kind,
    retainedSampleCount: applyReport.retainedSampleCount,
    backupFilePath: applyReport.backupFilePath,
    reason: applyReport.reason,
  };
  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      [
        `已执行保留策略：${applyReport.kind}`,
        `保留样本：${String(applyReport.retainedSampleCount)}`,
        `备份：${applyReport.backupFilePath ?? "（未创建）"}`,
        `说明：${applyReport.reason}`,
        "",
      ].join("\n"),
    );
  }
  if (applyReport.kind === "abandoned") {
    logToStderr("保留整理被放弃：文件保持原样（不会静默丢历史）。");
    return EXIT_CODES.FAILURE;
  }
  return EXIT_CODES.SUCCESS;
}

/** 供测试确认文件是否存在（避免测试里直接碰 fs 常量）。 */
export async function readProcessSamplesFileText(stateDirectory: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(stateDirectory, "perf", "process-samples.jsonl"), "utf8");
  } catch {
    return null;
  }
}
