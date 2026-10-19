/**
 * OBS 自动 rotate 的**触发判定**契约（2026-10-20 R113）。
 *
 * 卡内依据（OBS-01 §2）：存储预算耗尽时"先停可选详细采集并报告，**不静默删除历史**"；
 * 采集"默认关闭"；"正常用户任务优先"。
 *
 * 卡内遗留的"定时自动 rotate"此前被我按"需产品决定周期"挂起。**周期可以留给产品配置**，
 * 但"在什么条件下**允许**自动触发"是可以先冻结的判定层 —— 本模块只做这件事：
 *
 * 1. **未开启采集 ⇒ 不 rotate**（`collection-disabled`）；
 * 2. **用户任务进行中 ⇒ 不 rotate**（`user-task-active`，正常任务优先）；
 * 3. **存储用量未知 ⇒ 不 rotate**（`storage-unknown`，不猜余额/占用）；
 * 4. **时钟回拨 ⇒ 不 rotate**（`clock-skew`，不按错乱的间隔判到期）；
 * 5. 到期或超预算 ⇒ **允许 rotate**，但**不代表允许删除备份**：`isBackupPruneAllowed` 恒 false
 *    （清理备份必须由用户显式 `--prune-backups` 发起）；
 * 6. 判定结果**必须带原因**（`reasonCode`），便于如实报告"这次为什么没跑"。
 *
 * ## 边界
 * 不读盘、不计时、不删文件：输入即调用方观测到的状态。
 */
/** 触发判定结论。 */
export type ObservabilityRotateTriggerDecision =
  | {
      readonly kind: "rotate";
      readonly reasonCode: "over-budget" | "due-by-interval";
      readonly isBackupPruneAllowed: false;
      readonly reason: string;
    }
  | {
      readonly kind: "skip";
      readonly reasonCode:
        | "collection-disabled"
        | "user-task-active"
        | "storage-unknown"
        | "clock-skew"
        | "not-due";
      readonly isBackupPruneAllowed: false;
      readonly reason: string;
    };

/** 判定是否允许自动 rotate。 */
export function evaluateObservabilityRotateTrigger(input: {
  readonly isCollectionEnabled: boolean;
  readonly isUserTaskActive: boolean;
  /** 当前 perf 目录占用字节；`null` 表示未知（不猜）。 */
  readonly storageBytesUsed: number | null;
  readonly budgetBytes: number;
  readonly lastRotateAtIso: string | null;
  readonly nowIso: string;
  /** 距上次 rotate 多久算到期；缺省 24 小时。 */
  readonly minimumIntervalHours?: number;
}): ObservabilityRotateTriggerDecision {
  const minimumIntervalHours = input.minimumIntervalHours ?? 24;

  if (!input.isCollectionEnabled) {
    return {
      kind: "skip",
      reasonCode: "collection-disabled",
      isBackupPruneAllowed: false,
      reason: "采集未开启：不自动 rotate（默认 off）。",
    };
  }
  if (input.isUserTaskActive) {
    return {
      kind: "skip",
      reasonCode: "user-task-active",
      isBackupPruneAllowed: false,
      reason: "用户任务进行中：正常任务优先，自动整理让路。",
    };
  }
  if (input.storageBytesUsed === null) {
    return {
      kind: "skip",
      reasonCode: "storage-unknown",
      isBackupPruneAllowed: false,
      reason: "存储占用未知：不猜是否超预算，本次不 rotate。",
    };
  }

  // 超预算：即使未到期也允许整理（预算耗尽必须收口，但不删备份）
  if (input.storageBytesUsed > input.budgetBytes) {
    return {
      kind: "rotate",
      reasonCode: "over-budget",
      isBackupPruneAllowed: false,
      reason: `占用 ${String(input.storageBytesUsed)}B 超过预算 ${String(input.budgetBytes)}B：允许按保留策略整理（备份仍需用户显式清理）。`,
    };
  }

  const nowMilliseconds = Date.parse(input.nowIso);
  if (Number.isNaN(nowMilliseconds)) {
    return {
      kind: "skip",
      reasonCode: "clock-skew",
      isBackupPruneAllowed: false,
      reason: "nowIso 无法解析：不按错乱时间判到期。",
    };
  }
  if (input.lastRotateAtIso === null) {
    return {
      kind: "rotate",
      reasonCode: "due-by-interval",
      isBackupPruneAllowed: false,
      reason: "从未整理过：允许首次整理。",
    };
  }
  const lastRotateMilliseconds = Date.parse(input.lastRotateAtIso);
  if (Number.isNaN(lastRotateMilliseconds) || lastRotateMilliseconds > nowMilliseconds) {
    return {
      kind: "skip",
      reasonCode: "clock-skew",
      isBackupPruneAllowed: false,
      reason: "上次整理时间不可解析或晚于当前时间（时钟回拨）：本次不 rotate。",
    };
  }
  const elapsedHours = (nowMilliseconds - lastRotateMilliseconds) / 3_600_000;
  if (elapsedHours < minimumIntervalHours) {
    return {
      kind: "skip",
      reasonCode: "not-due",
      isBackupPruneAllowed: false,
      reason: `距上次整理 ${elapsedHours.toFixed(1)}h < ${String(minimumIntervalHours)}h：未到期。`,
    };
  }
  return {
    kind: "rotate",
    reasonCode: "due-by-interval",
    isBackupPruneAllowed: false,
    reason: `距上次整理 ${elapsedHours.toFixed(1)}h ≥ ${String(minimumIntervalHours)}h：允许整理。`,
  };
}
