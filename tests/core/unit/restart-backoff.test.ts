/**
 * 重启退避抖动（2026-11-13，新模块）：线性退避 + 有界抖动，随机源可注入。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESTART_BACKOFF_JITTER_RATIO,
  computeRestartDelayMilliseconds,
} from "../../../packages/core/src/feedback-process/restart-backoff.js";

function compute(overrides: Partial<Parameters<typeof computeRestartDelayMilliseconds>[0]> = {}) {
  return computeRestartDelayMilliseconds({
    attempt: 2,
    baseMilliseconds: 1_000,
    jitterRatio: 0.25,
    random: () => 0.5,
    ...overrides,
  });
}

describe("重启退避抖动", () => {
  it("① 无抖动时等于线性退避 base × attempt", () => {
    expect(compute({ jitterRatio: 0 })).toBe(2_000);
    expect(compute({ attempt: 5, jitterRatio: 0 })).toBe(5_000);
  });

  it("② 抖动落在有界区间内（随机源取端点也不越界）", () => {
    /** random=0 ⇒ 最小；random→1 ⇒ 最大。 */
    expect(compute({ random: () => 0 })).toBe(1_500);
    expect(compute({ random: () => 1 })).toBe(2_500);
    expect(compute({ random: () => 0.999999 })).toBeLessThanOrEqual(2_500);
  });

  it("③ 不产生 0 延迟（立即重启本身是抖动源）", () => {
    expect(compute({ attempt: 1, baseMilliseconds: 0, jitterRatio: 0.25 })).toBe(0);
    expect(compute({ attempt: 1, baseMilliseconds: 1, jitterRatio: 1, random: () => 0 })).toBe(1);
  });

  it("④ 参数非法 ⇒ 拒绝（不静默改成别的值）", () => {
    expect(() => compute({ attempt: 0 })).toThrow(/≥1 的整数/u);
    expect(() => compute({ baseMilliseconds: -1 })).toThrow(/非负有限数/u);
    expect(() => compute({ jitterRatio: 1.5 })).toThrow(/\[0,1\]/u);
  });

  it("⑤ 默认抖动比例为 0（对测试时钟保持确定性，开启需注入随机源）", () => {
    expect(DEFAULT_RESTART_BACKOFF_JITTER_RATIO).toBe(0);
  });
});
