/**
 * B9（2026-11-24）：远端同步结果的本地保全触发判定。
 *
 * 纪律：只有**已失败**才保全；网络失败立即保全（不等重试耗尽）；
 * 未尝试/正在尝试/成功都**不**保全，并且分类原样透出（不重写状态）。
 */
import { describe, expect, it } from "vitest";

import {
  evaluateRemoteSyncPreservationTrigger,
  type RemoteSyncOutcome,
  type RemoteSyncStatus,
} from "../../../packages/core/src/orchestration/local-preservation-service.js";

function outcome(status: RemoteSyncStatus): RemoteSyncOutcome {
  return {
    status,
    remoteName: "origin",
    branchName: "main",
    attemptCount: 1,
    lastFailureClass:
      status.startsWith("failed") ? (status as RemoteSyncOutcome["lastFailureClass"]) : null,
    observedAtIso: "2026-11-24T00:00:00.000Z",
    observedFailureMessage: status.startsWith("failed") ? "失败" : null,
  };
}

describe("B9：本地保全触发判定", () => {
  it("① 同步成功 ⇒ 不保全（分类原样 succeeded）", () => {
    expect(evaluateRemoteSyncPreservationTrigger(outcome("succeeded"))).toEqual({
      shouldPreserve: false,
      classification: "succeeded",
      reason: "remote-sync-succeeded: 同步成功，不需要本地保全",
    });
  });

  it("② 未尝试 / 正在尝试 ⇒ 不保全（尚未失败）", () => {
    for (const status of ["not-attempted", "attempting"] as const) {
      expect(evaluateRemoteSyncPreservationTrigger(outcome(status))).toEqual({
        shouldPreserve: false,
        classification: status,
        reason: "remote-sync-not-failed: 尚未发生同步失败，不需要本地保全",
      });
    }
  });

  it("③ 网络失败 ⇒ 立即保全（不等重试耗尽）", () => {
    expect(evaluateRemoteSyncPreservationTrigger(outcome("failed-network"))).toEqual({
      shouldPreserve: true,
      classification: "failed-network",
      reason: "remote-sync-failed-network: 网络失败立即保全（不等待重试耗尽）",
    });
  });

  it("④ 认证/被拒/无远端/未知失败 ⇒ 均保全，且原因带原分类", () => {
    for (const status of [
      "failed-authentication",
      "failed-rejected",
      "failed-no-remote",
      "failed-unknown",
    ] as const) {
      const decision = evaluateRemoteSyncPreservationTrigger(outcome(status));
      expect(decision.shouldPreserve).toBe(true);
      expect(decision.classification).toBe(status);
      expect(decision.reason).toContain(status);
      expect(decision.reason.startsWith("remote-sync-failed: ")).toBe(true);
    }
  });
});
