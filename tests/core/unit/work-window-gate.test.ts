/** GUI-03-05：工作时段门禁的收尾语义。 */
import { describe, expect, it } from "vitest";

import {
  createPauseReasonState,
  type WorkWindowRule,
} from "../../../packages/core/src/orchestration/work-window-contract.js";
import { evaluateWorkWindowGate } from "../../../packages/core/src/orchestration/work-window-gate.js";

const alwaysRest: WorkWindowRule = {
  ruleIdentifier: "always-rest",
  mode: "rest-blacklist",
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  startMinuteOfDay: 0,
  endMinuteOfDay: 1440,
  timeZone: "Asia/Shanghai",
  priority: "periodic",
  validFromUtcIso: null,
  validUntilUtcIso: null,
  scopeKind: "project",
};

describe("工作时段收尾", () => {
  it("① 休息时在途长工具允许收尾", () => {
    const decision = evaluateWorkWindowGate({
      gatePoint: "tool-execution",
      nowIso: "2026-10-27T00:00:00.000Z",
      rules: [alwaysRest],
      pauseReasonState: createPauseReasonState(),
      isLongRunningContinuation: true,
    });
    expect(decision.kind).toBe("allow");
  });

  it("② 休息时新工作仍被拒绝", () => {
    const decision = evaluateWorkWindowGate({
      gatePoint: "dispatch",
      nowIso: "2026-10-27T00:00:00.000Z",
      rules: [alwaysRest],
      pauseReasonState: createPauseReasonState(),
    });
    expect(decision.kind).toBe("deny");
  });
});
