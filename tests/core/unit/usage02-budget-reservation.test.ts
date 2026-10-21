/**
 * USAGE-01-02 预算预留/结算反例（2026-10-21）。
 *
 * 覆盖卡内点名：**并发预算**、**取消缺 usage**、**跨模型切换**、**重启（revision 连续性）**、
 * 重复预留、超出预算拒绝、以及"未知用量不释放预留"的保守口径。
 */
import { describe, expect, it } from "vitest";

import {
  computeUsageReservationFingerprint,
  createUsageBudgetState,
  describeUsageBudgetAfterModelSwitch,
  evaluateUsageBudgetView,
  reserveUsageBudget,
  settleUsageBudget,
  type UsageBudgetPolicy,
} from "../../../packages/core/src/orchestration/usage-budget-reservation.js";

const policy: UsageBudgetPolicy = { inputTokenLimit: 1000, requestLimit: 5 };

function reserve(state = createUsageBudgetState(), overrides: Record<string, unknown> = {}) {
  return reserveUsageBudget({
    state,
    policy,
    expectedRevision: state.revision,
    reservationIdentifier: "res-1",
    modelIdentifier: "model-a",
    estimatedInputTokenCount: 100,
    requestCount: 1,
    ...overrides,
  });
}

describe("USAGE-01-02 预算预留与结算", () => {
  it("① 正常预留 ⇒ reserved，revision +1，视图显示预留占用", () => {
    const outcome = reserve();
    expect(outcome.kind).toBe("reserved");
    if (outcome.kind !== "reserved") throw new Error("unreachable");
    const view = evaluateUsageBudgetView({ state: outcome.state, policy });
    expect(view.reservedInputTokenCount).toBe(100);
    expect(view.remainingInputTokenCount).toBe(900);
    expect(view.isDeterminable).toBe(true);
  });

  it("② 超出 token 预算 ⇒ 拒绝（不预留）", () => {
    const outcome = reserve(createUsageBudgetState(), { estimatedInputTokenCount: 1001 });
    expect(outcome).toMatchObject({ kind: "denied", reasonCode: "would-exceed-token-budget" });
  });

  it("③ 超出请求数预算 ⇒ 拒绝", () => {
    const outcome = reserve(createUsageBudgetState(), { requestCount: 6 });
    expect(outcome).toMatchObject({ kind: "denied", reasonCode: "would-exceed-request-budget" });
  });

  it("④ 并发预算：两个同 revision 的预留 ⇒ 第二个 stale-revision（不丢更新）", () => {
    const base = createUsageBudgetState();
    const first = reserve(base);
    expect(first.kind).toBe("reserved");
    // 用**旧 revision** 再预留（模拟并发）
    const second = reserve(base, { expectedRevision: 1, reservationIdentifier: "res-2" });
    expect(second.kind).toBe("stale-revision");
  });

  it("⑤ 并发预算：串行预留累计超限 ⇒ 第二次被拒（保守预留生效）", () => {
    const first = reserve(createUsageBudgetState(), { estimatedInputTokenCount: 600 });
    if (first.kind !== "reserved") throw new Error("unreachable");
    const second = reserve(first.state, { reservationIdentifier: "res-2", estimatedInputTokenCount: 500 });
    expect(second).toMatchObject({ kind: "denied", reasonCode: "would-exceed-token-budget" });
  });

  it("⑥ 重复预留 ID ⇒ duplicate-reservation（不重复占用）", () => {
    const first = reserve();
    if (first.kind !== "reserved") throw new Error("unreachable");
    const duplicate = reserve(first.state, { estimatedInputTokenCount: 100 });
    expect(duplicate).toMatchObject({ kind: "denied", reasonCode: "duplicate-reservation" });
  });

  it("⑦ 结算：用量已知 ⇒ 释放多余预留并记账", () => {
    const reserved = reserve(createUsageBudgetState(), { estimatedInputTokenCount: 300 });
    if (reserved.kind !== "reserved") throw new Error("unreachable");
    const settled = settleUsageBudget({
      state: reserved.state,
      expectedRevision: reserved.state.revision,
      reservationIdentifier: "res-1",
      isUsageKnown: true,
      actualInputTokenCount: 120,
      actualRequestCount: 1,
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind !== "settled") throw new Error("unreachable");
    expect(settled.releasedInputTokenCount).toBe(180);
    const view = evaluateUsageBudgetView({ state: settled.state, policy });
    expect(view.settledInputTokenCount).toBe(120);
    expect(view.reservedInputTokenCount).toBe(0);
    expect(view.remainingInputTokenCount).toBe(880);
  });

  it("⑧ 取消且缺 usage ⇒ kept-conservative（预留保留，判定不可确定）", () => {
    const reserved = reserve(createUsageBudgetState(), { estimatedInputTokenCount: 800 });
    if (reserved.kind !== "reserved") throw new Error("unreachable");
    const settled = settleUsageBudget({
      state: reserved.state,
      expectedRevision: reserved.state.revision,
      reservationIdentifier: "res-1",
      isUsageKnown: false,
    });
    expect(settled.kind).toBe("kept-conservative");
    if (settled.kind !== "kept-conservative") throw new Error("unreachable");
    const view = evaluateUsageBudgetView({ state: settled.state, policy });
    expect(view.hasUnknownUsage).toBe(true);
    expect(view.isDeterminable).toBe(false);
    // 预留仍然占着：剩余额度不会因"取消"而虚增
    expect(view.reservedInputTokenCount).toBe(800);
    expect(view.remainingInputTokenCount).toBe(200);
  });

  it("⑨ 未知用量之后继续预留 ⇒ 仍按保守占用判定（可能被拒）", () => {
    const reserved = reserve(createUsageBudgetState(), { estimatedInputTokenCount: 800 });
    if (reserved.kind !== "reserved") throw new Error("unreachable");
    const unknown = settleUsageBudget({
      state: reserved.state,
      expectedRevision: reserved.state.revision,
      reservationIdentifier: "res-1",
      isUsageKnown: false,
    });
    if (unknown.kind !== "kept-conservative") throw new Error("unreachable");
    const next = reserve(unknown.state, { reservationIdentifier: "res-2", estimatedInputTokenCount: 300 });
    expect(next).toMatchObject({ kind: "denied", reasonCode: "would-exceed-token-budget" });
  });

  it("⑩ 跨模型切换：旧模型预留不清除，新模型独立视图", () => {
    const reserved = reserve(createUsageBudgetState(), { estimatedInputTokenCount: 400, modelIdentifier: "model-a" });
    if (reserved.kind !== "reserved") throw new Error("unreachable");
    const switched = describeUsageBudgetAfterModelSwitch({
      state: reserved.state,
      policy,
      fromModelIdentifier: "model-a",
      toModelIdentifier: "model-b",
    });
    expect(switched.fromModelView.reservedInputTokenCount).toBe(400);
    expect(switched.toModelView.reservedInputTokenCount).toBe(0);
    expect(switched.toModelView.remainingInputTokenCount).toBe(1000);
  });

  it("⑪ 重启（revision 连续）：新状态按已持久化 revision 继续接受预留", () => {
    const first = reserve();
    if (first.kind !== "reserved") throw new Error("unreachable");
    // 模拟重启：只拿到持久化 state
    const afterRestart = reserve(first.state, { reservationIdentifier: "res-2" });
    expect(afterRestart.kind).toBe("reserved");
  });

  it("⑫ 结算旧 revision ⇒ stale-revision（不覆盖并发写入）", () => {
    const reserved = reserve();
    if (reserved.kind !== "reserved") throw new Error("unreachable");
    const settled = settleUsageBudget({
      state: reserved.state,
      expectedRevision: reserved.state.revision - 1,
      reservationIdentifier: "res-1",
      isUsageKnown: true,
      actualInputTokenCount: 10,
    });
    expect(settled.kind).toBe("stale-revision");
  });

  it("⑬ 非法预留参数 ⇒ 拒绝（token 负数 / 请求数 0）", () => {
    expect(reserve(createUsageBudgetState(), { estimatedInputTokenCount: -1 })).toMatchObject({
      kind: "denied",
      reasonCode: "invalid-request",
    });
    expect(reserve(createUsageBudgetState(), { requestCount: 0 })).toMatchObject({
      kind: "denied",
      reasonCode: "invalid-request",
    });
  });

  it("⑭ 结算不存在的预留 ⇒ unknown-reservation（不静默）", () => {
    const settled = settleUsageBudget({
      state: createUsageBudgetState(),
      expectedRevision: 0,
      reservationIdentifier: "missing",
      isUsageKnown: true,
    });
    expect(settled.kind).toBe("unknown-reservation");
  });

  it("⑮ 指纹：同参数稳定、参数变则不同（审计可复算）", () => {
    const base = {
      reservationIdentifier: "res-1",
      modelIdentifier: "model-a",
      estimatedInputTokenCount: 100,
      requestCount: 1,
    };
    expect(computeUsageReservationFingerprint(base)).toBe(computeUsageReservationFingerprint({ ...base }));
    expect(computeUsageReservationFingerprint(base)).not.toBe(
      computeUsageReservationFingerprint({ ...base, estimatedInputTokenCount: 101 }),
    );
  });
});


