import { describe, expect, it } from "vitest";

import {
  resolveContextPhaseBudget,
} from "../../../packages/core/src/orchestration/context-phase-policy.js";

describe("P4 context phase policy", () => {
  it("gives planning the full configured history budget", () => {
    const budget = resolveContextPhaseBudget({
      phase: "planning",
      configuredHistoryTokenCount: 4096,
      maximumPromptTokenCount: 10_000,
    });
    expect(budget.historyTokenCount).toBe(4096);
    expect(budget.maximumPromptTokenCount).toBe(10_000);
  });

  it("reduces the history budget for execution, verification and recall", () => {
    expect(
      resolveContextPhaseBudget({
        phase: "execution",
        configuredHistoryTokenCount: 4096,
      }).historyTokenCount,
    ).toBe(3072);
    expect(
      resolveContextPhaseBudget({
        phase: "verification",
        configuredHistoryTokenCount: 4096,
      }).historyTokenCount,
    ).toBe(2457);
    expect(
      resolveContextPhaseBudget({
        phase: "recall",
        configuredHistoryTokenCount: 4096,
      }).historyTokenCount,
    ).toBe(2048);
  });

  it("applies an explicit policy and rejects invalid ratios", () => {
    const budget = resolveContextPhaseBudget({
      phase: "execution",
      configuredHistoryTokenCount: 1000,
      maximumPromptTokenCount: 2000,
      policy: { historyTokenRatio: 0.4, promptTokenRatio: 0.5 },
    });
    expect(budget.historyTokenCount).toBe(400);
    expect(budget.maximumPromptTokenCount).toBe(1000);
    expect(() =>
      resolveContextPhaseBudget({
        phase: "execution",
        configuredHistoryTokenCount: 1000,
        policy: { historyTokenRatio: 2, promptTokenRatio: 1 },
      }),
    ).toThrow(/context-budget-invalid|between 0 and 1/u);
  });
});
