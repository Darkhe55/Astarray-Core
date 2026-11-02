/**
 * R134（2026-11-02）：图变更后是否暂停目标的判定单测。
 */
import { describe, expect, it } from "vitest";

import { shouldPauseForGraphChange } from "../../packages/core/src/orchestration/goal-graph-change-decision.js";

describe("图变更后的暂停判定", () => {
  it("V 上升 ⇒ 暂停（有要求失去证据）", () => {
    const decision = shouldPauseForGraphChange({
      previousPotentialValue: 0,
      nextPotentialValue: 1,
    });
    expect(decision.shouldPause).toBe(true);
    expect(decision.reason).toContain("V 上升");
  });

  it("V 不变或下降 ⇒ 不暂停", () => {
    expect(
      shouldPauseForGraphChange({ previousPotentialValue: 1, nextPotentialValue: 1 })
        .shouldPause,
    ).toBe(false);
    expect(
      shouldPauseForGraphChange({ previousPotentialValue: 1, nextPotentialValue: 0 })
        .shouldPause,
    ).toBe(false);
  });

  it("无法计算（null）⇒ 不暂停、不打断", () => {
    expect(
      shouldPauseForGraphChange({ previousPotentialValue: 1, nextPotentialValue: null })
        .shouldPause,
    ).toBe(false);
    expect(
      shouldPauseForGraphChange({ previousPotentialValue: null, nextPotentialValue: 1 })
        .shouldPause,
    ).toBe(false);
  });
});
