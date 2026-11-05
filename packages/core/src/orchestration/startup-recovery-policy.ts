/**
 * 启动自动恢复：策略模型（Phase 1，2026-11-05）。
 *
 * 只做**策略读写**与默认值；不恢复、不启动任务。默认值按建议：
 * - 仅恢复被中断的任务（running / blocked 且租约过期）；
 * - 每次启动最多 3 个、并发 1；
 * - 含写任务默认不自动恢复（需显式勾选）；
 * - 类型标签未知 ⇒ 按"未确认"处理，不自动恢复。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { cleanStaleTempFiles, readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export const STARTUP_RECOVERY_POLICY_SCHEMA_VERSION = 1;

/** 恢复类型标签（Phase 3 会从 mission 元数据派生；Phase 1 只认显式标签）。 */
export type StartupRecoveryTaskLabel =
  | "normal"
  | "goal"
  | "has-writes"
  | "needs-permission"
  | "unknown";

export interface StartupRecoveryPolicy {
  readonly schemaVersion: typeof STARTUP_RECOVERY_POLICY_SCHEMA_VERSION;
  /** 总开关；关闭时只允许只读扫描，不自动恢复。 */
  readonly isEnabled: boolean;
  /** 每次启动最多恢复几个 mission（0 = 只扫描不恢复）。 */
  readonly maximumResumePerStartup: number;
  /** 同时恢复的 mission 数（1..4）。 */
  readonly maximumConcurrentResumes: number;
  /** 允许自动恢复的标签；空数组表示"不按类型恢复任何任务"。 */
  readonly allowedTaskLabels: readonly StartupRecoveryTaskLabel[];
  /** 需要用户逐项确认的标签（即使 allowed 也先确认）。 */
  readonly requireConfirmationFor: readonly StartupRecoveryTaskLabel[];
  /** 单个任务连续失败达到上限后停手（Phase 4）。 */
  readonly maximumAttemptsPerTask: number;
  /** 两批恢复之间的冷却（毫秒，Phase 4）。 */
  readonly cooldownMilliseconds: number;
  /** 启动后延迟多久开始恢复（毫秒），避免与初始化竞争。 */
  readonly startupDelayMilliseconds: number;
}

export const DEFAULT_STARTUP_RECOVERY_POLICY: StartupRecoveryPolicy = {
  schemaVersion: STARTUP_RECOVERY_POLICY_SCHEMA_VERSION,
  isEnabled: false,
  maximumResumePerStartup: 3,
  maximumConcurrentResumes: 1,
  /** 含写任务默认不自动恢复：默认只允许普通任务。 */
  allowedTaskLabels: ["normal"],
  requireConfirmationFor: ["has-writes", "needs-permission"],
  maximumAttemptsPerTask: 2,
  cooldownMilliseconds: 30_000,
  startupDelayMilliseconds: 3_000,
};

const ALLOWED_LABELS: readonly StartupRecoveryTaskLabel[] = [
  "normal",
  "goal",
  "has-writes",
  "needs-permission",
  "unknown",
];

/** 读取时做边界校验（不 clamp 静默修正；越界即拒绝，避免"以为改了其实没改"）。 */
export function parseStartupRecoveryPolicy(value: unknown): StartupRecoveryPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("invalid-task-chain", "启动恢复策略必须是 JSON 对象。");
  }
  const record = value as Record<string, unknown>;
  const readBoolean = (fieldName: string, fallback: boolean): boolean => {
    const raw = record[fieldName];
    if (raw === undefined) return fallback;
    if (typeof raw !== "boolean") {
      throw new DomainError("invalid-task-chain", `启动恢复策略字段 ${fieldName} 必须是布尔值。`);
    }
    return raw;
  };
  const readInteger = (
    fieldName: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number => {
    const raw = record[fieldName];
    if (raw === undefined) return fallback;
    if (!Number.isInteger(raw) || (raw as number) < minimum || (raw as number) > maximum) {
      throw new DomainError(
        "invalid-task-chain",
        `启动恢复策略字段 ${fieldName} 必须是 ${String(minimum)}..${String(maximum)} 的整数。`,
      );
    }
    return raw as number;
  };
  const readLabels = (fieldName: string, fallback: readonly StartupRecoveryTaskLabel[]) => {
    const raw = record[fieldName];
    if (raw === undefined) return fallback;
    if (!Array.isArray(raw)) {
      throw new DomainError("invalid-task-chain", `启动恢复策略字段 ${fieldName} 必须是数组。`);
    }
    for (const entry of raw) {
      if (typeof entry !== "string" || !ALLOWED_LABELS.includes(entry as StartupRecoveryTaskLabel)) {
        throw new DomainError(
          "invalid-task-chain",
          `启动恢复策略字段 ${fieldName} 含未知标签: ${String(entry)}`,
        );
      }
    }
    return [...new Set(raw as StartupRecoveryTaskLabel[])];
  };
  return {
    schemaVersion: STARTUP_RECOVERY_POLICY_SCHEMA_VERSION,
    isEnabled: readBoolean("isEnabled", DEFAULT_STARTUP_RECOVERY_POLICY.isEnabled),
    maximumResumePerStartup: readInteger("maximumResumePerStartup", 3, 0, 20),
    maximumConcurrentResumes: readInteger("maximumConcurrentResumes", 1, 1, 4),
    allowedTaskLabels: readLabels(
      "allowedTaskLabels",
      DEFAULT_STARTUP_RECOVERY_POLICY.allowedTaskLabels,
    ),
    requireConfirmationFor: readLabels(
      "requireConfirmationFor",
      DEFAULT_STARTUP_RECOVERY_POLICY.requireConfirmationFor,
    ),
    maximumAttemptsPerTask: readInteger("maximumAttemptsPerTask", 2, 1, 10),
    cooldownMilliseconds: readInteger("cooldownMilliseconds", 30_000, 0, 3_600_000),
    startupDelayMilliseconds: readInteger("startupDelayMilliseconds", 3_000, 0, 60_000),
  };
}

export class StartupRecoveryPolicyStore {
  private readonly directoryPath: string;
  private readonly filePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "startup-recovery");
    this.filePath = path.join(this.directoryPath, "policy.json");
  }

  /** 文件不存在 ⇒ 返回默认策略（不落盘），让"未配置"与"显式关闭"可区分。 */
  async readPolicy(): Promise<{ policy: StartupRecoveryPolicy; isPersisted: boolean }> {
    const result = await readJsonWithBackupRecovery(
      this.filePath,
      `${this.filePath}.bak`,
    ).catch(() => null);
    if (result === null) {
      return { policy: DEFAULT_STARTUP_RECOVERY_POLICY, isPersisted: false };
    }
    return { policy: parseStartupRecoveryPolicy(result.content), isPersisted: true };
  }

  async writePolicy(policy: StartupRecoveryPolicy): Promise<StartupRecoveryPolicy> {
    const validated = parseStartupRecoveryPolicy(policy);
    return this.writeLock.runExclusive(async () => {
      await fs.mkdir(this.directoryPath, { recursive: true });
      await cleanStaleTempFiles(this.directoryPath, "policy.json");
      await writeAtomicJson(this.filePath, validated);
      return validated;
    });
  }
}
