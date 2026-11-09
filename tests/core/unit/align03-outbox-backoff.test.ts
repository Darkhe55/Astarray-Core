/**
 * ALIGN-03-06（2026-11-09）：**补送退避策略**。
 *
 * 缺口（卡内点名）：补送"无上限/无退避"—— 每次心跳都重试全部积压条目，
 * 子进程长期不可用时每个心跳都要走一遍 IPC 超时，可能长期占用通道。
 *
 * 本文件验证策略本身；**不**声称已验证"心跳触发退避"的端到端行为。
 */
import { describe, expect, it, vi } from "vitest";

import { computeOutboxBackoffMilliseconds } from "../../../packages/core/src/feedback-process/transport.js";

vi.setConfig({ testTimeout: 30_000 });

describe("ALIGN-03-06 补送退避", () => {
  it("按次数指数增长：1s → 2s → 4s → 8s", () => {
    expect(computeOutboxBackoffMilliseconds(1)).toBe(1_000);
    expect(computeOutboxBackoffMilliseconds(2)).toBe(2_000);
    expect(computeOutboxBackoffMilliseconds(3)).toBe(4_000);
    expect(computeOutboxBackoffMilliseconds(4)).toBe(8_000);
  });

  it("有上限：不超过 60 秒（不会无限膨胀）", () => {
    expect(computeOutboxBackoffMilliseconds(20)).toBe(60_000);
    expect(computeOutboxBackoffMilliseconds(1_000)).toBe(60_000);
  });

  it("**不设重试上限**：退避饱和后仍会重试（消息不被静默丢弃）", () => {
    /** 饱和值仍是有限等待，而不是"放弃"。 */
    const saturatedDelay = computeOutboxBackoffMilliseconds(100);
    expect(Number.isFinite(saturatedDelay)).toBe(true);
    expect(saturatedDelay).toBe(60_000);
  });

  it("退化输入（0 / 负数）按第 1 次处理", () => {
    expect(computeOutboxBackoffMilliseconds(0)).toBe(1_000);
    expect(computeOutboxBackoffMilliseconds(-5)).toBe(1_000);
  });
});
