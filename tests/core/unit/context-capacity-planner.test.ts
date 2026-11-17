import { describe, expect, it } from "vitest";

import { planContextCapacity } from "../../../packages/core/src/orchestration/context-capacity-planner.js";

describe("P1 context capacity planner", () => {
  it("keeps the configured budget when the model window is unknown", () => {
    const plan = planContextCapacity({
      configuredHistoryTokenCount: 4096,
      reservedInputTokens: 500,
    });
    expect(plan.isModelWindowKnown).toBe(false);
    expect(plan.effectiveHistoryTokenCount).toBe(4096);
    expect(plan.availableHistoryTokens).toBeNull();
  });

  it("subtracts system, task, tools and output reserve before applying the history budget", () => {
    const plan = planContextCapacity({
      configuredHistoryTokenCount: 4096,
      modelInputSpaceTokens: 10_000,
      systemRulesTokenCount: 800,
      taskTokenCount: 1_200,
      toolDocumentationTokenCount: 1_000,
      outputReserveTokenCount: 2_000,
      protocolOverheadTokenCount: 200,
    });
    expect(plan.reservedInputTokens).toBe(5_200);
    expect(plan.availableHistoryTokens).toBe(4_800);
    expect(plan.effectiveHistoryTokenCount).toBe(4096);
    expect(plan.budgetReductionReason).toBeNull();
  });

  it("reduces the history budget and explains the reduction when reserves leave too little space", () => {
    const plan = planContextCapacity({
      configuredHistoryTokenCount: 4096,
      modelInputSpaceTokens: 5_000,
      systemRulesTokenCount: 2_000,
      taskTokenCount: 1_500,
      toolDocumentationTokenCount: 500,
      outputReserveTokenCount: 500,
    });
    expect(plan.availableHistoryTokens).toBe(500);
    expect(plan.effectiveHistoryTokenCount).toBe(500);
    expect(plan.budgetReductionReason).toContain("输入空间");
  });

  it("returns zero rather than a negative budget when reserves exceed the model window", () => {
    const plan = planContextCapacity({
      configuredHistoryTokenCount: 4096,
      modelInputSpaceTokens: 2_000,
      systemRulesTokenCount: 2_000,
      outputReserveTokenCount: 2_000,
    });
    expect(plan.availableHistoryTokens).toBe(0);
    expect(plan.effectiveHistoryTokenCount).toBe(0);
  });

  it("rejects negative reserved token counts", () => {
    expect(() =>
      planContextCapacity({
        configuredHistoryTokenCount: 4096,
        reservedInputTokens: -1,
      }),
    ).toThrow(/non-negative/u);
  });
});
