/**
 * 反馈子进程重启退避（2026-11-13）。
 *
 * 原实现是线性退避 `base × attempt`，没有任何抖动：多个 supervisor 同时崩溃时，
 * 会**同一时刻**一起重启，形成同步撞车（再叠加负载，就更容易再次被判定失联）。
 *
 * 这里在退避上叠加**有界抖动**，并把随机源作为参数注入，便于测试确定性：
 * 实际延迟落在 `[base×attempt×(1-jitter), base×attempt×(1+jitter)]` 区间内，
 * 且始终 ≥1ms（立即重启本身就是抖动源之一）。
 */
import { DomainError } from "../core/errors.js";

export interface RestartBackoffInput {
  /** 第几次重启（从 1 开始）。 */
  readonly attempt: number;
  /** 基础退避（毫秒）。 */
  readonly baseMilliseconds: number;
  /** 抖动比例（0..1）；0 表示不退避抖动。 */
  readonly jitterRatio: number;
  /** 随机源（返回 [0,1)）；注入以便测试确定性。 */
  readonly random: () => number;
}

export const DEFAULT_RESTART_BACKOFF_JITTER_RATIO = 0.25;

export function computeRestartDelayMilliseconds(input: RestartBackoffInput): number {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new DomainError(
      "invalid-task-chain",
      `重启次数必须是 ≥1 的整数（收到 ${String(input.attempt)}）。`,
    );
  }
  if (!Number.isFinite(input.baseMilliseconds) || input.baseMilliseconds < 0) {
    throw new DomainError(
      "invalid-task-chain",
      `基础退避必须是非负有限数（收到 ${String(input.baseMilliseconds)}）。`,
    );
  }
  if (!Number.isFinite(input.jitterRatio) || input.jitterRatio < 0 || input.jitterRatio > 1) {
    throw new DomainError(
      "invalid-task-chain",
      `抖动比例必须在 [0,1] 内（收到 ${String(input.jitterRatio)}）。`,
    );
  }
  const linearDelayMilliseconds = input.baseMilliseconds * input.attempt;
  if (linearDelayMilliseconds === 0) {
    return 0;
  }
  const jitterSpanMilliseconds = linearDelayMilliseconds * input.jitterRatio;
  /** 把 `random()` 映射到 [-1,1]，再缩放到抖动区间。 */
  const offsetMilliseconds = (input.random() * 2 - 1) * jitterSpanMilliseconds;
  return Math.max(1, Math.round(linearDelayMilliseconds + offsetMilliseconds));
}
