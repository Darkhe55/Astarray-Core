/**
 * 启动自动恢复：按机器负载动态计算本次恢复上限（2026-11-05）。
 *
 * 用户口径："默认上限根据机器运行情况动态调整占用率"。
 *
 * 纯函数，不读系统；调用方传入采样：
 * - `loadAverage1m === null`（如 Windows 上 loadavg 无意义）⇒ 只用内存压力；
 * - `cpuCount` 用于把 loadavg 归一化；
 * - 压力 = max(CPU 压力, 内存压力)；达到目标占用率 ⇒ 收缩到下界，否则线性回升。
 *
 * 结果始终在 `[minimumResumePerStartup, maximumResumePerStartup]` 内；
 * 关闭动态调整时直接返回上限。
 */
import type { StartupRecoveryPolicy } from "./startup-recovery-policy.js";

export interface StartupRecoveryCapacitySample {
  readonly cpuCount: number;
  /** 1 分钟负载；Windows 无法提供时传 null（不要伪造 0）。 */
  readonly loadAverage1m: number | null;
  readonly freeMemoryBytes: number;
  readonly totalMemoryBytes: number;
}

export interface StartupRecoveryCapacityDecision {
  readonly effectiveLimit: number;
  readonly maximumLimit: number;
  readonly minimumLimit: number;
  readonly cpuUtilization: number;
  readonly memoryUtilization: number;
  readonly pressure: number;
  readonly targetUtilization: number;
  readonly isAdaptive: boolean;
  readonly reason: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function computeAdaptiveResumeLimit(
  policy: Pick<
    StartupRecoveryPolicy,
    | "maximumResumePerStartup"
    | "minimumResumePerStartup"
    | "isLoadAdaptive"
    | "targetCpuUtilization"
    | "targetMemoryUtilization"
  >,
  sample: StartupRecoveryCapacitySample,
): StartupRecoveryCapacityDecision {
  const maximumLimit = policy.maximumResumePerStartup;
  const minimumLimit = Math.min(policy.minimumResumePerStartup, maximumLimit);
  const cpuUtilization =
    sample.loadAverage1m === null || sample.cpuCount <= 0
      ? 0
      : Math.max(0, sample.loadAverage1m) / sample.cpuCount;
  const memoryUtilization =
    sample.totalMemoryBytes <= 0
      ? 0
      : clamp(1 - sample.freeMemoryBytes / sample.totalMemoryBytes, 0, 1);
  const targetUtilization = Math.max(
    policy.targetCpuUtilization,
    policy.targetMemoryUtilization,
  );
  const pressure = Math.max(cpuUtilization, memoryUtilization);
  if (!policy.isLoadAdaptive) {
    return {
      effectiveLimit: maximumLimit,
      maximumLimit,
      minimumLimit,
      cpuUtilization,
      memoryUtilization,
      pressure,
      targetUtilization,
      isAdaptive: false,
      reason: "动态上限已关闭：使用配置上限",
    };
  }
  /** 压力 ≥ 目标 ⇒ 下界；压力为 0 ⇒ 上限；中间线性。 */
  const capacityRatio =
    pressure >= targetUtilization
      ? 0
      : clamp((targetUtilization - pressure) / targetUtilization, 0, 1);
  const effectiveLimit = clamp(
    Math.round(minimumLimit + (maximumLimit - minimumLimit) * capacityRatio),
    minimumLimit,
    maximumLimit,
  );
  return {
    effectiveLimit,
    maximumLimit,
    minimumLimit,
    cpuUtilization,
    memoryUtilization,
    pressure,
    targetUtilization,
    isAdaptive: true,
    reason:
      pressure >= targetUtilization
        ? `机器压力 ${pressure.toFixed(2)} 已达目标 ${targetUtilization.toFixed(2)}：收缩到下界 ${String(minimumLimit)}`
        : `机器压力 ${pressure.toFixed(2)} / 目标 ${targetUtilization.toFixed(2)}：本次上限 ${String(effectiveLimit)}`,
  };
}
