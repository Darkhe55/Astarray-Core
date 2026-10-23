/**
 * EVENT-01 验收口径校验反例（2026-10-23）。
 *
 * 口径不完整 ⇒ 不得开工、不得宣称通过；只有四项齐全且合法才算完整。
 */
import { describe, expect, it } from "vitest";

import {
  EVENT_RECOVERY_POLICIES,
  evaluateEventAcceptanceCriteria,
  type EventAcceptanceCriteria,
} from "../../../packages/core/src/orchestration/event-acceptance-criteria.js";

function complete(overrides: Partial<EventAcceptanceCriteria> = {}): EventAcceptanceCriteria {
  return {
    eventSources: ["process-exit", "provider-failure"],
    responseDeadlineSeconds: 60,
    recoveryPolicy: "require-user-confirmation",
    requiredEvidence: ["storm-no-ping-pong", "single-owner", "old-epoch-rejected"],
    ...overrides,
  };
}

describe("EVENT-01 验收口径", () => {
  it("① 四项齐全 ⇒ 完整，可开工", () => {
    const verdict = evaluateEventAcceptanceCriteria(complete());
    expect(verdict).toMatchObject({ isComplete: true, missingFields: [] });
    expect(verdict.reason).toContain("可以开始");
  });

  it("② 全空 ⇒ 四个字段都列为缺失，并明确不得开工", () => {
    const verdict = evaluateEventAcceptanceCriteria({});
    expect(verdict.isComplete).toBe(false);
    expect(verdict.missingFields).toEqual([
      "eventSources",
      "responseDeadlineSeconds",
      "recoveryPolicy",
      "requiredEvidence",
    ]);
    expect(verdict.reason).toContain("不得");
  });

  it("③ 空事件源清单（或全是空串）⇒ 不算完整", () => {
    expect(evaluateEventAcceptanceCriteria(complete({ eventSources: [] })).isComplete).toBe(false);
    expect(evaluateEventAcceptanceCriteria(complete({ eventSources: ["  "] })).isComplete).toBe(false);
  });

  it("④ 响应期限非正数 ⇒ 不完整（0 / 负数 / NaN）", () => {
    for (const deadline of [0, -5, Number.NaN]) {
      const verdict = evaluateEventAcceptanceCriteria(complete({ responseDeadlineSeconds: deadline }));
      expect(verdict.isComplete).toBe(false);
      expect(verdict.problems.join(" ")).toContain("响应期限");
    }
  });

  it("⑤ 恢复策略不在枚举内 ⇒ 不完整", () => {
    const verdict = evaluateEventAcceptanceCriteria(complete({ recoveryPolicy: "auto" as never }));
    expect(verdict.isComplete).toBe(false);
    expect(verdict.problems.join(" ")).toContain("恢复策略");
    expect(EVENT_RECOVERY_POLICIES).toContain("require-user-confirmation");
  });

  it("⑥ 缺完成证据 ⇒ 不完整（不能只说“跑通了”）", () => {
    const verdict = evaluateEventAcceptanceCriteria(complete({ requiredEvidence: [] }));
    expect(verdict.isComplete).toBe(false);
    expect(verdict.missingFields).toContain("requiredEvidence");
  });
});
