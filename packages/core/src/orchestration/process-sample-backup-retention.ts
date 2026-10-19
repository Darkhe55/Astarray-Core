/**
 * 保留策略**备份**的清理规则（2026-10-20 R102）。
 *
 * 背景：R54 的保留执行会先写 `process-samples.backup-<时间戳>.jsonl` 再重写；
 * 每次 `--apply` 都留一个备份，**从不清理** ⇒ 备份会无限增长（把"安全"变成新的存储问题）。
 *
 * 本模块只做**判定**（纯函数）：给一批备份文件名，算出"该保留哪些、该删哪些"。纪律：
 * 1. **永远保留最新一份**（哪怕它超出条数/时限）—— 否则出事时无备份可用；
 * 2. **不一次删空**：保留数量下限为 1；
 * 3. 无法解析时间戳的文件名 ⇒ **保留并报告**（不认识的东西不擅自删）；
 * 4. 判定结果**只增不减**地解释原因，供调用方打印。
 *
 * ## 边界
 * 不读盘、不删文件：实际删除由调用方按计划执行。
 */
/** 备份文件名前缀（与 R54 一致）。 */
export const PROCESS_SAMPLE_BACKUP_FILE_PREFIX = "process-samples.backup-";

/** 判定计划。 */
export interface BackupRetentionPlan {
  readonly kind: "no-action" | "delete-required";
  readonly keepFileNames: ReadonlyArray<string>;
  readonly deleteFileNames: ReadonlyArray<string>;
  /** 因"不认识文件名"而**保留**的数量（如实报告，不静默）。 */
  readonly unparsableFileCount: number;
  readonly reason: string;
}

/** 从备份文件名解析时间（无法解析返回 null）。 */
export function parseBackupFileRecordedAtIso(fileName: string): string | null {
  if (!fileName.startsWith(PROCESS_SAMPLE_BACKUP_FILE_PREFIX)) return null;
  if (!fileName.endsWith(".jsonl")) return null;
  const rawStamp = fileName.slice(PROCESS_SAMPLE_BACKUP_FILE_PREFIX.length, -".jsonl".length);
  // R54 写盘时把 ':' 换成 '-'（Windows 不允许冒号）：2026-10-19T12-00-00.000Z
  const restoredStamp = rawStamp.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/,
    "$1:$2:$3",
  );
  const recordedAtMilliseconds = Date.parse(restoredStamp);
  if (Number.isNaN(recordedAtMilliseconds)) return null;
  return new Date(recordedAtMilliseconds).toISOString();
}

/** 计算备份清理计划。 */
export function planProcessSampleBackupRetention(input: {
  readonly backupFileNames: ReadonlyArray<string>;
  readonly nowIso: string;
  /** 最多保留几份（含最新那份）；缺省 5。 */
  readonly maximumBackupCount?: number;
  /** 超过多少小时的备份可删；缺省 168（7 天）。 */
  readonly maximumAgeHours?: number;
}): BackupRetentionPlan {
  const maximumBackupCount = input.maximumBackupCount ?? 5;
  const maximumAgeHours = input.maximumAgeHours ?? 168;
  const nowMilliseconds = Date.parse(input.nowIso);
  if (Number.isNaN(nowMilliseconds)) {
    return {
      kind: "no-action",
      keepFileNames: [...input.backupFileNames],
      deleteFileNames: [],
      unparsableFileCount: 0,
      reason: "nowIso 无法解析：不猜测时间，保持原样。",
    };
  }

  const known: Array<{ fileName: string; recordedAtMilliseconds: number }> = [];
  const unknown: string[] = [];
  for (const fileName of input.backupFileNames) {
    const recordedAtIso = parseBackupFileRecordedAtIso(fileName);
    if (recordedAtIso === null) {
      unknown.push(fileName);
      continue;
    }
    known.push({ fileName, recordedAtMilliseconds: Date.parse(recordedAtIso) });
  }

  // 新 → 旧
  known.sort((left, right) => right.recordedAtMilliseconds - left.recordedAtMilliseconds);

  const oldestAllowedMilliseconds = nowMilliseconds - maximumAgeHours * 3_600_000;
  const deleteFileNames: string[] = [];
  const keepFileNames: string[] = [];
  known.forEach((entry, index) => {
    const isNewest = index === 0;
    const isWithinCount = index < maximumBackupCount;
    const isWithinAge = entry.recordedAtMilliseconds >= oldestAllowedMilliseconds;
    // 最新一份**永远**保留；其余满足"条数内"或"时限内"任一即保留
    if (isNewest || isWithinCount || isWithinAge) {
      keepFileNames.push(entry.fileName);
    } else {
      deleteFileNames.push(entry.fileName);
    }
  });

  const keepFileNamesWithUnknown = [...keepFileNames, ...unknown];
  if (deleteFileNames.length === 0) {
    return {
      kind: "no-action",
      keepFileNames: keepFileNamesWithUnknown,
      deleteFileNames: [],
      unparsableFileCount: unknown.length,
      reason: "没有超出条数与时限的备份：无需清理。",
    };
  }
  return {
    kind: "delete-required",
    keepFileNames: keepFileNamesWithUnknown,
    deleteFileNames,
    unparsableFileCount: unknown.length,
    reason: `可清理 ${String(deleteFileNames.length)} 份备份（保留最新与最近 ${String(maximumBackupCount)} 份/近 ${String(maximumAgeHours)} 小时内的）。`,
  };
}
