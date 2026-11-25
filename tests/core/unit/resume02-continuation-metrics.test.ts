/**
 * RESUME-02 补口（2026-11-25）：观测计数的反例（有界、只读、不漏不重）。
 */
import { describe, expect, it } from "vitest";

import { ContinuationMetrics } from "../../../packages/core/src/orchestration/continuation-metrics.js";

describe("RESUME-02 观测计数", () => {
  it("① 按 outcome × reasonCode 计数，总计一致", () => {
    const metrics = new ContinuationMetrics();
    metrics.record({ outcome: "resumed", reasonCode: "resumed" });
    metrics.record({ outcome: "resumed", reasonCode: "resumed" });
    metrics.record({ outcome: "blocked", reasonCode: "recovery-blocked-by-core" });
    metrics.record({ outcome: "needs-selection" });

    const snapshot = metrics.snapshot();
    expect(snapshot.total).toBe(4);
    expect(snapshot.entries).toEqual([
      { outcome: "blocked", reasonCode: "recovery-blocked-by-core", count: 1 },
      { outcome: "needs-selection", reasonCode: null, count: 1 },
      { outcome: "resumed", reasonCode: "resumed", count: 2 },
    ]);
  });

  it("② 快照是冻结副本：改返回值不影响内部状态", () => {
    const metrics = new ContinuationMetrics();
    metrics.record({ outcome: "resumed", reasonCode: "resumed" });
    const snapshot = metrics.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(() => {
      (snapshot.entries as unknown as unknown[]).push({});
    }).toThrow();
    expect(metrics.snapshot().total).toBe(1);
  });

  it("③ 维度有界：第 33 个不同原因码归入 other，条目数不膨胀", () => {
    const metrics = new ContinuationMetrics();
    for (let index = 0; index < 40; index += 1) {
      metrics.record({ outcome: "blocked", reasonCode: `reason-${String(index)}` });
    }
    const snapshot = metrics.snapshot();
    expect(snapshot.total).toBe(40);
    const reasonCodes = new Set(snapshot.entries.map((entry) => entry.reasonCode));
    expect(reasonCodes.size).toBeLessThanOrEqual(33);
    expect(reasonCodes.has("other")).toBe(true);
    /** 前 32 个仍精确保留（不是全归 other）。 */
    expect(reasonCodes.has("reason-0")).toBe(true);
    expect(reasonCodes.has("reason-31")).toBe(true);
  });

  it("④ 空白原因码归一为 null（不产生空字符串维度）", () => {
    const metrics = new ContinuationMetrics();
    metrics.record({ outcome: "disabled", reasonCode: "   " });
    metrics.record({ outcome: "disabled" });
    expect(metrics.snapshot().entries).toEqual([
      { outcome: "disabled", reasonCode: null, count: 2 },
    ]);
  });

  it("⑤ reset 清空计数与原因码集合", () => {
    const metrics = new ContinuationMetrics();
    metrics.record({ outcome: "resumed", reasonCode: "resumed" });
    metrics.reset();
    expect(metrics.snapshot()).toEqual({ total: 0, entries: [] });
  });

  it("⑥ 长跑不泄漏：重复同一维度只增加 count，条目数不变", () => {
    const metrics = new ContinuationMetrics();
    for (let index = 0; index < 1_000; index += 1) {
      metrics.record({ outcome: "reconciling", reasonCode: "waiting" });
    }
    const snapshot = metrics.snapshot();
    expect(snapshot.total).toBe(1_000);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.count).toBe(1_000);
  });
});
