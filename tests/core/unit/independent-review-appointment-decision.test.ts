/**
 * 2026-11-18 返修反例：独立验收任命**必须绑定权威版本**，读不到就不任命。
 *
 * 此前这里写死 `taskRevision: 1`——任务链推进后仍在撒谎。
 */
import { describe, expect, it } from "vitest";

import { decideIndependentReviewAppointment } from "../../../packages/core/src/orchestration/independent-review-appointment-decision.js";

describe("独立验收任命的版本决定", () => {
  it("① 任务链 revision=2 ⇒ 任命绑定 2（不是写死的 1）", () => {
    const decision = decideIndependentReviewAppointment({ revision: 2 });
    expect(decision).toEqual({ kind: "appoint", taskRevision: 2 });
  }, 30_000);

  it("② 读不到任务链 ⇒ 拒绝任命（不伪造版本）", () => {
    const decision = decideIndependentReviewAppointment(null);
    expect(decision.kind).toBe("refused");
    if (decision.kind === "refused") {
      expect(decision.reason).toContain("不伪造版本");
    }
  }, 30_000);

  it("③ revision 非法（0 / 非整数）⇒ 拒绝任命", () => {
    expect(decideIndependentReviewAppointment({ revision: 0 }).kind).toBe("refused");
    expect(decideIndependentReviewAppointment({ revision: 1.5 }).kind).toBe("refused");
  }, 30_000);
});
