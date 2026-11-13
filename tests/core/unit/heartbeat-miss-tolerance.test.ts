/**
 * 心跳错过容忍计数（2026-11-13，新模块）。
 *
 * 这是把"一次错过就退出"改成"连续 N 次才退出"的最小可测单元：
 * 容忍度 1 保持旧行为；心跳恢复必须清零，否则容器会漏掉"恢复了又失联"的场景。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEARTBEAT_MISS_TOLERANCE_COUNT,
  createHeartbeatMissTolerance,
} from "../../../packages/core/src/feedback-process/heartbeat-miss-tolerance.js";

describe("心跳错过容忍", () => {
  it("① 容忍度 1 ⇒ 第一次错过就应退出（旧行为）", () => {
    const tolerance = createHeartbeatMissTolerance({ toleranceCount: 1 });
    expect(tolerance.shouldExit()).toBe(false);
    expect(tolerance.recordMiss()).toBe(1);
    expect(tolerance.shouldExit()).toBe(true);
  });

  it("② 容忍度 2 ⇒ 第一次不退出、第二次退出（单次抖动不再误杀）", () => {
    const tolerance = createHeartbeatMissTolerance({ toleranceCount: 2 });
    tolerance.recordMiss();
    expect(tolerance.shouldExit()).toBe(false);
    tolerance.recordMiss();
    expect(tolerance.shouldExit()).toBe(true);
    expect(tolerance.getConsecutiveMissCount()).toBe(2);
  });

  it("③ 心跳恢复 ⇒ 连续计数清零（漏一次后又恢复，不应累计到退出）", () => {
    const tolerance = createHeartbeatMissTolerance({ toleranceCount: 2 });
    tolerance.recordMiss();
    tolerance.recordHeartbeat();
    expect(tolerance.getConsecutiveMissCount()).toBe(0);
    tolerance.recordMiss();
    expect(tolerance.shouldExit()).toBe(false);
  });

  it("④ 默认容忍度为 2，且非法容忍度拒绝创建", () => {
    expect(DEFAULT_HEARTBEAT_MISS_TOLERANCE_COUNT).toBe(2);
    for (const invalid of [0, -1, 1.5]) {
      expect(() => createHeartbeatMissTolerance({ toleranceCount: invalid })).toThrow(/≥1 的整数/u);
    }
  });
});
