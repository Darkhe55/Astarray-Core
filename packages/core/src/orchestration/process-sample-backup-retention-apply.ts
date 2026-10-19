/**
 * 备份清理的**执行**（2026-10-20 R103）：判定（R102）→ 逐个删除 → 如实回报。
 *
 * 为什么把删除做成**注入端口**：破坏性文件 API 必须集中在白名单模块（架构守卫 T12-05），
 * 而"删除哪几个"是与 IO 无关的判定。分开之后：
 * - 本模块可以纯逻辑测试（注入记录器即可）；
 * - 真正调用 `fs.rm` 的只有 CLI 侧一层薄接线，且它必须走白名单 helper。
 *
 * 纪律：①只删计划内文件，**不扫不猜**；②某个删除失败 ⇒ **立即停**并回报已删/未删，
 * 不继续删剩下的（避免"删一半"的状态被误报为成功）；③没有任何计划 ⇒ 不动盘。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  PROCESS_SAMPLE_BACKUP_FILE_PREFIX,
  planProcessSampleBackupRetention,
} from "./process-sample-backup-retention.js";

/** 执行结果。 */
export interface BackupRetentionApplyReport {
  readonly kind: "no-action" | "pruned" | "aborted";
  readonly plannedDeleteFileNames: ReadonlyArray<string>;
  readonly deletedFileNames: ReadonlyArray<string>;
  readonly unparsableFileCount: number;
  readonly reason: string;
}

/** 按判定结果删除备份文件（删除动作由调用方注入）。 */
export async function applyProcessSampleBackupRetention(input: {
  readonly baseDirectory: string;
  readonly nowIso: string;
  readonly maximumBackupCount?: number;
  readonly maximumAgeHours?: number;
  /** 注入的删除端口：入参是**绝对路径**。 */
  readonly removeBackupFile: (absoluteFilePath: string) => Promise<void>;
}): Promise<BackupRetentionApplyReport> {
  const backupDirectoryPath = path.join(input.baseDirectory, "perf");
  let directoryEntries: string[];
  try {
    directoryEntries = await fs.readdir(backupDirectoryPath);
  } catch {
    return {
      kind: "no-action",
      plannedDeleteFileNames: [],
      deletedFileNames: [],
      unparsableFileCount: 0,
      reason: "没有 perf 目录：无需清理备份。",
    };
  }

  const backupFileNames = directoryEntries.filter((entry) =>
    entry.startsWith(PROCESS_SAMPLE_BACKUP_FILE_PREFIX),
  );
  const plan = planProcessSampleBackupRetention({
    backupFileNames,
    nowIso: input.nowIso,
    ...(input.maximumBackupCount === undefined
      ? {}
      : { maximumBackupCount: input.maximumBackupCount }),
    ...(input.maximumAgeHours === undefined ? {} : { maximumAgeHours: input.maximumAgeHours }),
  });

  if (plan.deleteFileNames.length === 0) {
    return {
      kind: "no-action",
      plannedDeleteFileNames: [],
      deletedFileNames: [],
      unparsableFileCount: plan.unparsableFileCount,
      reason: plan.reason,
    };
  }

  const deletedFileNames: string[] = [];
  for (const fileName of plan.deleteFileNames) {
    try {
      await input.removeBackupFile(path.join(backupDirectoryPath, fileName));
      deletedFileNames.push(fileName);
    } catch (error) {
      // 失败即停：不继续删，如实回报"删到一半"
      return {
        kind: "aborted",
        plannedDeleteFileNames: plan.deleteFileNames,
        deletedFileNames,
        unparsableFileCount: plan.unparsableFileCount,
        reason: `删除 ${fileName} 失败，已停止：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    kind: "pruned",
    plannedDeleteFileNames: plan.deleteFileNames,
    deletedFileNames,
    unparsableFileCount: plan.unparsableFileCount,
    reason: `已删除 ${String(deletedFileNames.length)} 份超出条数与时限的备份。`,
  };
}
