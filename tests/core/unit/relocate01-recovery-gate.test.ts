/**
 * RELOCATE-01 检查点 03 的**反例**（2026-10-18 第 16 轮）：重定位后的恢复门禁。
 */
import { describe, expect, it } from "vitest";

import { decideRecoveryAfterRelocation } from "../../../packages/core/src/orchestration/project-relocation-recovery-gate.js";

const pendingOperation = {
  operationIdentifier: "op-1",
  isCompleted: false,
  isIdempotent: true,
  hasUnknownSideEffect: false,
};

const baseInput = {
  operation: pendingOperation,
  hasCurrentPermissionAtNewLocation: true,
  reliesOnPreviousOneTimeGrant: false,
  reliesOnTemporaryEscalation: false,
};

describe("RELOCATE-01-03：恢复门禁（已完成的绝不重放）", () => {
  it("① 已确认完成 ⇒ skip-already-completed（即使依赖旧许可也不重跑）", () => {
    const outcome = decideRecoveryAfterRelocation({
      ...baseInput,
      operation: { ...pendingOperation, isCompleted: true },
      reliesOnPreviousOneTimeGrant: true,
    });
    expect(outcome.kind).toBe("skip-already-completed");
  });

  it("② 依赖旧一次性许可 ⇒ blocked stale-grant-not-restored", () => {
    const outcome = decideRecoveryAfterRelocation({
      ...baseInput,
      reliesOnPreviousOneTimeGrant: true,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("应为 blocked");
    expect(outcome.rejectionCode).toBe("stale-grant-not-restored");
  });

  it("③ 依赖已失效临时提升 ⇒ blocked stale-grant-not-restored", () => {
    const outcome = decideRecoveryAfterRelocation({
      ...baseInput,
      reliesOnTemporaryEscalation: true,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("应为 blocked");
    expect(outcome.rejectionCode).toBe("stale-grant-not-restored");
  });

  it("④ 新位置未通过当前权限检查 ⇒ blocked permission-recheck-required（旧授权不迁移）", () => {
    const outcome = decideRecoveryAfterRelocation({
      ...baseInput,
      hasCurrentPermissionAtNewLocation: false,
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("应为 blocked");
    expect(outcome.rejectionCode).toBe("permission-recheck-required");
  });

  it("⑤ 未知非幂等副作用 ⇒ blocked unknown-side-effect（不能因换路径重试）", () => {
    const outcome = decideRecoveryAfterRelocation({
      ...baseInput,
      operation: { ...pendingOperation, isIdempotent: false, hasUnknownSideEffect: true },
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("应为 blocked");
    expect(outcome.rejectionCode).toBe("unknown-side-effect");
  });

  it("⑥ 未完成 + 权限通过 + 幂等 ⇒ may-retry", () => {
    const outcome = decideRecoveryAfterRelocation(baseInput);
    expect(outcome.kind).toBe("may-retry");
  });

  it("⑦ 幂等操作即使副作用未知 ⇒ 仍允许重试（幂等不产生额外副作用）", () => {
    const outcome = decideRecoveryAfterRelocation({
      ...baseInput,
      operation: { ...pendingOperation, isIdempotent: true, hasUnknownSideEffect: true },
    });
    expect(outcome.kind).toBe("may-retry");
  });

  it("⑧ 多个阻断条件同时成立 ⇒ 按固定优先级报（stale-grant 先于 permission/unknown）", () => {
    const outcome = decideRecoveryAfterRelocation({
      ...baseInput,
      reliesOnPreviousOneTimeGrant: true,
      hasCurrentPermissionAtNewLocation: false,
      operation: { ...pendingOperation, isIdempotent: false, hasUnknownSideEffect: true },
    });
    expect(outcome.kind).toBe("blocked");
    if (outcome.kind !== "blocked") throw new Error("应为 blocked");
    expect(outcome.rejectionCode).toBe("stale-grant-not-restored");
  });
});
