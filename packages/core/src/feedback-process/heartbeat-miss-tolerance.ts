/**
 * 反馈子进程的心跳**容错**计数（2026-11-13）。
 *
 * 背景：子进程原本"一次没收到心跳就自我退出（code=1）"。高并行负载下，
 * 主进程的事件循环可能被挤占到超过一个心跳周期，于是**误判主进程失联**：
 * 子进程退出 → 父侧记 `反馈进程故障` → 重启 → 再次误判，形成抖动。
 *
 * 这里把判定收窄为"**连续** N 次错过才退出"，且任何一次心跳都清零——
 * 真失联（主进程真的没了）仍会在 N 个周期后退出，只是不再对单次抖动过度反应。
 */
import { DomainError } from "../core/errors.js";

export interface HeartbeatMissToleranceOptions {
  /**
   * 允许的**连续**错过次数：达到即应退出。
   * `1` 等价于旧行为（一次错过就退出）。
   */
  readonly toleranceCount: number;
}

export interface HeartbeatMissTolerance {
  /** 收到心跳：清零连续计数。 */
  readonly recordHeartbeat: () => void;
  /** 记一次错过：返回累计的连续错过次数。 */
  readonly recordMiss: () => number;
  /** 是否已达容忍上限（达到就该退出）。 */
  readonly shouldExit: () => boolean;
  readonly getConsecutiveMissCount: () => number;
}

export const DEFAULT_HEARTBEAT_MISS_TOLERANCE_COUNT = 2;

export function createHeartbeatMissTolerance(
  options: HeartbeatMissToleranceOptions,
): HeartbeatMissTolerance {
  if (
    !Number.isInteger(options.toleranceCount) ||
    options.toleranceCount < 1
  ) {
    throw new DomainError(
      "invalid-task-chain",
      `心跳容忍次数必须是 ≥1 的整数（收到 ${String(options.toleranceCount)}）。`,
    );
  }
  let consecutiveMissCount = 0;
  return {
    recordHeartbeat: () => {
      consecutiveMissCount = 0;
    },
    recordMiss: () => {
      consecutiveMissCount += 1;
      return consecutiveMissCount;
    },
    shouldExit: () => consecutiveMissCount >= options.toleranceCount,
    getConsecutiveMissCount: () => consecutiveMissCount,
  };
}
