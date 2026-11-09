/**
 * ALIGN-04-04（2026-11-09）：**工作时段恢复判定**（rest→working 只恢复一次）。
 *
 * 卡内 2026-10-28 记录"未跑任何一条判定路径"。
 * 本文件覆盖每条判定分支，尤其是两条最危险的：
 *  ① 手动取消后**不得**被唤醒复活；
 *  ② 同一次唤醒**不得**恢复两次（同一任务跑两遍）。
 */
import { describe, expect, it, vi } from "vitest";

import { evaluateWorkWindowResume } from "../../../packages/core/src/orchestration/work-window-resume.js";

vi.setConfig({ testTimeout: 30_000 });

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateWorkWindowResume({
    previousState: "resting",
    currentState: "working",
    hasPendingResume: true,
    isManuallyCancelled: false,
    hasResumedSinceWake: false,
    ...overrides,
  } as never);
}

describe("ALIGN-04-04 工作时段恢复判定", () => {
  it("rest→working 且有待恢复业务 ⇒ resume-once", () => {
    expect(evaluate().kind).toBe("resume-once");
  });

  it("**手动取消优先于一切** ⇒ 唤醒不得复活", () => {
    const decision = evaluate({ isManuallyCancelled: true });
    expect(decision.kind).toBe("suppressed-by-manual-cancel");
  });

  it("仍在休息时段 ⇒ 不恢复，也不产生模型请求", () => {
    const decision = evaluate({ currentState: "resting" });
    expect(decision.kind).toBe("no-new-business-calls");
  });

  it("没有待恢复业务 ⇒ nothing-pending", () => {
    expect(evaluate({ hasPendingResume: false }).kind).toBe("nothing-pending");
  });

  it("**本次唤醒已恢复过** ⇒ already-resumed（不跑两遍）", () => {
    const decision = evaluate({ hasResumedSinceWake: true });
    expect(decision.kind).toBe("already-resumed");
  });

  it("状态未发生 rest→working 变化 ⇒ nothing-pending（不因抖动恢复）", () => {
    const decision = evaluate({ previousState: "working" });
    expect(decision.kind).toBe("nothing-pending");
  });

  it("每种判定都给出可读原因（不得空串）", () => {
    const scenarios = [
      {},
      { isManuallyCancelled: true },
      { currentState: "resting" },
      { hasPendingResume: false },
      { hasResumedSinceWake: true },
      { previousState: "working" },
    ];
    for (const scenario of scenarios) {
      const decision = evaluate(scenario);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});
