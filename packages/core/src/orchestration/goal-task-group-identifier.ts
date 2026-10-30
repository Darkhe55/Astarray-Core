/**
 * R64（2026-10-30）：**目标组标识生成**（纯函数，便于单测）。
 *
 * 背景：R52 用 `goal-group-<UTC14>-<n>`，同一秒内重启且计数器相同理论上会**撞名**。
 * 现在追加 8 位随机令牌，使"哪一次运行的组"在任何情况下都可区分。
 *
 * 规则：
 * - 时间戳取 `startedAtIso` 的 UTC 14 位（`YYYYMMDDhhmmss`），与 `startedAtIso` 同源；
 * - 序号为进程内递增；
 * - 令牌 8 位小写十六进制（默认随机，可注入以便测试）。
 */
import { randomUUID } from "node:crypto";

export interface BuildGoalTaskGroupIdentifierInput {
  readonly startedAtIso: string;
  readonly sequenceNumber: number;
  /** 可注入的 8 位令牌（测试用）；缺省随机。 */
  readonly randomToken?: string;
}

/** 把 ISO 时间转成 14 位 UTC 串；非法输入抛错（不静默用当前时间替代）。 */
export function toGoalTaskGroupRunTag(startedAtIso: string): string {
  const parsed = new Date(startedAtIso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`startedAtIso 非法，无法生成组标识: ${startedAtIso}`);
  }
  return parsed.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

export function buildGoalTaskGroupIdentifier(
  input: BuildGoalTaskGroupIdentifierInput,
): string {
  const runTag = toGoalTaskGroupRunTag(input.startedAtIso);
  const sequenceNumber = Math.trunc(input.sequenceNumber);
  if (!Number.isFinite(sequenceNumber) || sequenceNumber < 1) {
    throw new Error(`组序号必须为正整数，收到: ${String(input.sequenceNumber)}`);
  }
  const randomToken =
    input.randomToken ?? randomUUID().replace(/-/g, "").slice(0, 8).toLowerCase();
  if (!/^[0-9a-z]{8}$/.test(randomToken)) {
    throw new Error(`组标识随机令牌必须是 8 位小写十六进制，收到: ${randomToken}`);
  }
  return `goal-group-${runTag}-${String(sequenceNumber)}-${randomToken}`;
}
