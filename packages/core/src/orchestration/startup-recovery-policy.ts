/**
 * 启动自动恢复：策略模型（2026-11-05，用户已修订口径）。
 *
 * 用户口径：
 * - **可恢复范围**：之前写入任务序列、仍未完成的内容（不再只看 running/blocked）；
 * - **上限按机器运行情况动态调整占用率**（不是固定 3）；
 * - **含写任务默认也自动恢复**，但要有提示（`notifyOnAutoResume`）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import { cleanStaleTempFiles, readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export const STARTUP_RECOVERY_POLICY_SCHEMA_VERSION = 1;

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
  /** 每次启动恢复数量的**上限**（动态上限不会超过它）。 */
  readonly maximumResumePerStartup: number;
  /** 动态上限的下界（机器很忙时仍至少恢复几个）。 */
  readonly minimumResumePerStartup: number;
  /** 是否按机器负载动态收缩到 `[minimum, maximum]` 区间。 */
  readonly isLoadAdaptive: boolean;
  /** CPU 占用目标（达到即收缩到最小值）。 */
  readonly targetCpuUtilization: number;
  /** 内存占用目标（达到即收缩到最小值）。 */
  readonly targetMemoryUtilization: number;
  /** 同时恢复的 mission 数（1..4）。 */
  readonly maximumConcurrentResumes: number;
  /** 允许自动恢复的标签（默认包含含写/需授权：用户要求默认都恢复）。 */
  readonly allowedTaskLabels: readonly StartupRecoveryTaskLabel[];
  /** 需要用户逐项确认的标签（默认空：含写也自动恢复）。 */
  readonly requireConfirmationFor: readonly StartupRecoveryTaskLabel[];
  /** 自动恢复含写/需授权任务时是否先提示（默认 true）。 */
  readonly notifyOnAutoResume: boolean;
  /** 单个任务连续失败达到上限后停手。 */
  readonly maximumAttemptsPerTask: number;
  readonly cooldownMilliseconds: number;
  /** 启动后延迟多久开始恢复（毫秒）。 */
  readonly startupDelayMilliseconds: number;
}

export const DEFAULT_STARTUP_RECOVERY_POLICY: StartupRecoveryPolicy = {
  schemaVersion: STARTUP_RECOVERY_POLICY_SCHEMA_VERSION,
  isEnabled: false,
  maximumResumePerStartup: 8,
  minimumResumePerStartup: 1,
  isLoadAdaptive: true,
  targetCpuUtilization: 0.7,
  targetMemoryUtilization: 0.8,
  maximumConcurrentResumes: 1,
  /** 用户要求：未完成内容默认都恢复（unknown 也会在 Phase 3 被细化）。 */
  allowedTaskLabels: ["normal", "goal", "has-writes", "needs-permission", "unknown"],
  requireConfirmationFor: [],
  notifyOnAutoResume: true,
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
  const readRatio = (fieldName: string, fallback: number): number => {
    const raw = record[fieldName];
    if (raw === undefined) return fallback;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw >= 1) {
      throw new DomainError(
        "invalid-task-chain",
        `启动恢复策略字段 ${fieldName} 必须是 (0,1) 之间的小数。`,
      );
    }
    return raw;
  };
  const readLabels = (
    fieldName: string,
    fallback: readonly StartupRecoveryTaskLabel[],
  ): readonly StartupRecoveryTaskLabel[] => {
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

  const maximumResumePerStartup = readInteger("maximumResumePerStartup", 8, 1, 50);
  const minimumResumePerStartup = readInteger("minimumResumePerStartup", 1, 1, 20);
  if (minimumResumePerStartup > maximumResumePerStartup) {
    throw new DomainError(
      "invalid-task-chain",
      "minimumResumePerStartup 不能大于 maximumResumePerStartup。",
    );
  }
  return {
    schemaVersion: STARTUP_RECOVERY_POLICY_SCHEMA_VERSION,
    isEnabled: readBoolean("isEnabled", DEFAULT_STARTUP_RECOVERY_POLICY.isEnabled),
    maximumResumePerStartup,
    minimumResumePerStartup,
    isLoadAdaptive: readBoolean("isLoadAdaptive", true),
    targetCpuUtilization: readRatio("targetCpuUtilization", 0.7),
    targetMemoryUtilization: readRatio("targetMemoryUtilization", 0.8),
    maximumConcurrentResumes: readInteger("maximumConcurrentResumes", 1, 1, 4),
    allowedTaskLabels: readLabels(
      "allowedTaskLabels",
      DEFAULT_STARTUP_RECOVERY_POLICY.allowedTaskLabels,
    ),
    requireConfirmationFor: readLabels("requireConfirmationFor", []),
    notifyOnAutoResume: readBoolean("notifyOnAutoResume", true),
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
