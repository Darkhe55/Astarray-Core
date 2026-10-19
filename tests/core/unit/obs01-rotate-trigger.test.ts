/**
 * OBS 自动 rotate 触发判定的反例（2026-10-20 R113）。
 */
import { describe, expect, it } from "vitest";

import { evaluateObservabilityRotateTrigger } from "../../../packages/core/src/orchestration/observability-rotate-trigger.js";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    isCollectionEnabled: true,
    isUserTaskActive: false,
    storageBytesUsed: 1_000,
    budgetBytes: 10_000,
    lastRotateAtIso: "2026-10-19T00:00:00.000Z",
    nowIso: "2026-10-19T02:00:00.000Z",
    ...overrides,
  } as Parameters<typeof evaluateObservabilityRotateTrigger>[0];
}

describe("OBS 自动 rotate 触发判定", () => {
  it("① 采集未开启 ⇒ 不 rotate（默认关闭）", () => {
    const decision = evaluateObservabilityRotateTrigger(baseInput({ isCollectionEnabled: false }));
    expect(decision).toMatchObject({ kind: "skip", reasonCode: "collection-disabled" });
  });

  it("② 用户任务进行中 ⇒ 不 rotate（正常任务优先）", () => {
    const decision = evaluateObservabilityRotateTrigger(baseInput({ isUserTaskActive: true }));
    expect(decision).toMatchObject({ kind: "skip", reasonCode: "user-task-active" });
  });

  it("③ 存储占用未知 ⇒ 不 rotate（不猜）", () => {
    const decision = evaluateObservabilityRotateTrigger(baseInput({ storageBytesUsed: null }));
    expect(decision).toMatchObject({ kind: "skip", reasonCode: "storage-unknown" });
  });

  it("④ 超预算 ⇒ 允许 rotate（即使未到期），但**不允许删备份**", () => {
    const decision = evaluateObservabilityRotateTrigger(
      baseInput({ storageBytesUsed: 20_000, lastRotateAtIso: "2026-10-19T01:59:00.000Z" }),
    );
    expect(decision).toMatchObject({ kind: "rotate", reasonCode: "over-budget" });
    expect(decision.isBackupPruneAllowed).toBe(false);
  });

  it("⑤ 到达间隔 ⇒ 允许 rotate；未到间隔 ⇒ skip(not-due)", () => {
    const due = evaluateObservabilityRotateTrigger(
      baseInput({ nowIso: "2026-10-20T01:00:00.000Z" }),
    );
    expect(due).toMatchObject({ kind: "rotate", reasonCode: "due-by-interval" });

    const notDue = evaluateObservabilityRotateTrigger(baseInput());
    expect(notDue).toMatchObject({ kind: "skip", reasonCode: "not-due" });
  });

  it("⑥ 从未整理过 ⇒ 允许首次整理", () => {
    const decision = evaluateObservabilityRotateTrigger(baseInput({ lastRotateAtIso: null }));
    expect(decision).toMatchObject({ kind: "rotate", reasonCode: "due-by-interval" });
  });

  it("⑦ 时钟回拨（上次整理晚于当前）⇒ 不 rotate", () => {
    const decision = evaluateObservabilityRotateTrigger(
      baseInput({ lastRotateAtIso: "2026-10-19T05:00:00.000Z", nowIso: "2026-10-19T02:00:00.000Z" }),
    );
    expect(decision).toMatchObject({ kind: "skip", reasonCode: "clock-skew" });
  });

  it("⑧ 任何结论都带原因，且**永不**允许自动删备份", () => {
    for (const input of [
      baseInput(),
      baseInput({ isCollectionEnabled: false }),
      baseInput({ isUserTaskActive: true }),
      baseInput({ storageBytesUsed: null }),
      baseInput({ storageBytesUsed: 99_999 }),
      baseInput({ lastRotateAtIso: null }),
      baseInput({ nowIso: "not-a-time" }),
    ]) {
      const decision = evaluateObservabilityRotateTrigger(input);
      expect(decision.isBackupPruneAllowed).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.reasonCode.length).toBeGreaterThan(0);
    }
  });
});
