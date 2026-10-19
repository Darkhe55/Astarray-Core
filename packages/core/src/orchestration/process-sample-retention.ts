/**
 * 进程样本的**保留策略**（2026-10-19 R53）：10MB 预算 + 24h 保留。
 *
 * 用户 2026-10-19 决策（按推荐）：**≤10MB 环形 / 24h 保留**；卡内约束：
 * "存储预算耗尽时先停可选详细采集并报告，**不静默删除历史**"。
 *
 * 本模块只做**判定与裁剪计划**（纯函数）：给出现有样本应当保留哪些、丢多少、为什么。
 * 真正的文件重写由调用方按计划执行（下一步接线），避免这里偷偷改盘。
 *
 * ## 规则
 * 1. **24h 保留**：早于 `nowIso - retentionHours` 的样本过期；
 * 2. **10MB 预算**：从**最新**往回累计，超出预算的旧样本被裁剪（优先保留新样本）；
 * 3. 两个原因都**如实报告**（`droppedByRetentionCount` / `droppedByBudgetCount`），
 *    **绝不静默丢弃**；
 * 4. 空计划（无需裁剪）也必须显式返回，而不是"看起来成功了"。
 */
/** 一条待判定的样本（只取判定所需的最小字段）。 */
export interface ProcessSampleRetentionCandidate {
  readonly recordedAtIso: string;
  /** 该行在文件中的字节数（含换行）。 */
  readonly serializedBytes: number;
}

/** 裁剪结论。 */
export interface ProcessSampleRetentionPlan {
  readonly kind: "no-action" | "trim-required";
  readonly retainedSampleCount: number;
  readonly droppedByRetentionCount: number;
  readonly droppedByBudgetCount: number;
  readonly retainedBytes: number;
  readonly droppedBytes: number;
  /** 由于过期而淘汰的最旧时间（无则 null）。 */
  readonly oldestDroppedAtIso: string | null;
  /** 保留窗口（供报告"这次数据覆盖到哪段"）；全部被裁剪时为 null。 */
  readonly retainedOldestAtIso: string | null;
  readonly retainedNewestAtIso: string | null;
  readonly reason: string;
}

/** 默认预算与保留期（与 R37 契约一致）。 */
export const DEFAULT_PROCESS_SAMPLE_BUDGET_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PROCESS_SAMPLE_RETENTION_HOURS = 24;

/**
 * 计算保留计划。
 *
 * 判定顺序：**先按时间过期淘汰**，再在剩余样本上按预算从新到旧累计。
 * （过期样本即使很小也不保留；预算裁剪只影响仍在保留期内的样本。）
 */
export function planProcessSampleRetention(input: {
  readonly samples: ReadonlyArray<ProcessSampleRetentionCandidate>;
  readonly nowIso: string;
  readonly budgetBytes?: number;
  readonly retentionHours?: number;
}): ProcessSampleRetentionPlan {
  const budgetBytes = input.budgetBytes ?? DEFAULT_PROCESS_SAMPLE_BUDGET_BYTES;
  const retentionHours = input.retentionHours ?? DEFAULT_PROCESS_SAMPLE_RETENTION_HOURS;
  const nowMilliseconds = Date.parse(input.nowIso);
  if (Number.isNaN(nowMilliseconds)) {
    return {
      kind: "no-action",
      retainedSampleCount: input.samples.length,
      droppedByRetentionCount: 0,
      droppedByBudgetCount: 0,
      retainedBytes: input.samples.reduce((total, sample) => total + sample.serializedBytes, 0),
      droppedBytes: 0,
      oldestDroppedAtIso: null,
      retainedOldestAtIso: null,
      retainedNewestAtIso: null,
      reason: "当前时间非法：不做裁剪判定（不猜测）。",
    };
  }
  const retentionBoundaryMilliseconds = nowMilliseconds - retentionHours * 3_600_000;

  let droppedByRetentionCount = 0;
  let oldestDroppedAtIso: string | null = null;
  const withinRetentionWindow: ProcessSampleRetentionCandidate[] = [];
  for (const sample of input.samples) {
    const recordedAtMilliseconds = Date.parse(sample.recordedAtIso);
    if (Number.isNaN(recordedAtMilliseconds) || recordedAtMilliseconds < retentionBoundaryMilliseconds) {
      droppedByRetentionCount += 1;
      if (oldestDroppedAtIso === null) oldestDroppedAtIso = sample.recordedAtIso;
      continue;
    }
    withinRetentionWindow.push(sample);
  }

  // 从**最新**往回累计预算（样本按时间升序传入时即从尾部开始）
  let retainedBytes = 0;
  let droppedByBudgetCount = 0;
  const retainedSamples: ProcessSampleRetentionCandidate[] = [];
  for (let index = withinRetentionWindow.length - 1; index >= 0; index -= 1) {
    const sample = withinRetentionWindow[index];
    if (sample === undefined) continue;
    if (retainedBytes + sample.serializedBytes <= budgetBytes) {
      retainedBytes += sample.serializedBytes;
      retainedSamples.push(sample);
      continue;
    }
    droppedByBudgetCount += 1;
  }
  const retainedSampleCount = retainedSamples.length;
  const retainedAtIsoList = retainedSamples.map((sample) => sample.recordedAtIso);
  const retainedOldestAtIso = retainedAtIsoList.length === 0 ? null : retainedAtIsoList[retainedAtIsoList.length - 1] ?? null;
  const retainedNewestAtIso = retainedAtIsoList.length === 0 ? null : retainedAtIsoList[0] ?? null;

  const droppedBytes =
    input.samples.reduce((total, sample) => total + sample.serializedBytes, 0) - retainedBytes;
  const isTrimRequired = droppedByRetentionCount > 0 || droppedByBudgetCount > 0;

  return {
    kind: isTrimRequired ? "trim-required" : "no-action",
    retainedSampleCount,
    droppedByRetentionCount,
    droppedByBudgetCount,
    retainedBytes,
    droppedBytes,
    oldestDroppedAtIso,
    retainedOldestAtIso,
    retainedNewestAtIso,
    reason: isTrimRequired
      ? `需裁剪：过期 ${String(droppedByRetentionCount)} 条、超预算 ${String(droppedByBudgetCount)} 条（保留 ${String(retainedSampleCount)} 条 / ${String(retainedBytes)} B）。`
      : "无需裁剪：全部样本在保留期内且未超预算。",
  };
}
