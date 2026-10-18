/**
 * CURATE-01-02 的反例（2026-10-19 R23）：周期增量执行、个体隔离、计划锁与恢复。
 *
 * 卡内验收：重复触发只执行一次、休息不运行、错过周期合并、重启保持授权边界、
 * 摘要失败原文不变、跨个体隔离。
 */
import { describe, expect, it } from "vitest";

import {
  acquireCurationRunLock,
  computeCurationRunIdentifier,
  evaluateCurationBatch,
  evaluateCurationEntryOwnership,
  evaluateCurationOutcome,
  evaluateCurationResume,
  evaluateCurationRunStart,
  planCurationPendingRun,
} from "../../../packages/core/src/orchestration/curation-execution-contract.js";

describe("CURATE-01-02：周期执行与锁/预算/恢复", () => {
  it("① 同方案重复触发 ⇒ 只有一个实例（幂等重放/拒绝并发）", () => {
    const first = acquireCurationRunLock({
      planIdentifier: "plan-1",
      runIdentifier: "run-1",
      acquiredAtIso: "2026-10-19T00:00:00.000Z",
      existingLock: null,
    });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") throw new Error("应获取");

    expect(
      acquireCurationRunLock({
        planIdentifier: "plan-1",
        runIdentifier: "run-2",
        acquiredAtIso: "2026-10-19T00:01:00.000Z",
        existingLock: first.lock,
      }),
    ).toMatchObject({ kind: "already-running" });
  });

  it("② 错过多个周期 ⇒ 合并为 1 次（不补跑全部遗漏）", () => {
    // 1440 分钟周期、错过 3 天 ⇒ 3 个周期但只排 1 次
    const planned = planCurationPendingRun({
      lastHandledAtIso: "2026-10-15T00:00:00.000Z",
      nowIso: "2026-10-18T00:00:00.000Z",
      intervalMinutes: 1_440,
    });
    expect(planned.isDue).toBe(true);
    expect(planned.missedPeriodCount).toBe(3);
    expect(planned.coalescedRunCount).toBe(1);

    expect(
      planCurationPendingRun({
        lastHandledAtIso: "2026-10-18T00:00:00.000Z",
        nowIso: "2026-10-18T01:00:00.000Z",
        intervalMinutes: 1_440,
      }).isDue,
    ).toBe(false);
  });

  it("③ 增量批次：只处理到已提交游标，新内容留给下一轮", () => {
    const batch = evaluateCurationBatch({
      committedCursor: 10,
      availableEntryCount: 15,
      maximumBatchSize: 6,
    });
    expect(batch.batchEntryCount).toBe(6);
    expect(batch.nextCursor).toBe(6);
    expect(batch.leavesNewerForNextRun).toBe(true);

    const exhausted = evaluateCurationBatch({
      committedCursor: 3,
      availableEntryCount: 3,
      maximumBatchSize: 10,
    });
    expect(exhausted.batchEntryCount).toBe(3);
    expect(exhausted.leavesNewerForNextRun).toBe(false);
  });

  it("④ 启动门禁：取消/休息/授权无效/旧 revision/预算/锁 全部拒绝", () => {
    const base = {
      isCancelled: false,
      isRestPeriod: false,
      isAuthorizationValid: true,
      authorizedPlanRevision: 2,
      currentPlanRevision: 2,
      hasBudget: true,
      hasLock: false,
    };
    expect(evaluateCurationRunStart({ ...base, isCancelled: true })).toMatchObject({
      reasonCode: "cancelled",
    });
    expect(evaluateCurationRunStart({ ...base, isRestPeriod: true })).toMatchObject({
      reasonCode: "rest-period",
    });
    expect(evaluateCurationRunStart({ ...base, isAuthorizationValid: false })).toMatchObject({
      reasonCode: "authorization-invalid",
    });
    expect(evaluateCurationRunStart({ ...base, authorizedPlanRevision: 1 })).toMatchObject({
      reasonCode: "authorization-revision-mismatch",
    });
    expect(evaluateCurationRunStart({ ...base, hasBudget: false })).toMatchObject({
      reasonCode: "budget-exhausted",
    });
    expect(evaluateCurationRunStart({ ...base, hasLock: true })).toMatchObject({
      reasonCode: "lock-held",
    });
    expect(evaluateCurationRunStart(base).kind).toBe("start");
  });

  it("⑤ 摘要失败：原文保持完整、不声称覆盖完整、保留失败原因", () => {
    const failed = evaluateCurationOutcome({
      summaryStatus: "failed",
      processedEntryCount: 4,
      failureReason: "provider-timeout",
    });
    expect(failed.status).toBe("failed");
    expect(failed.isOriginalContentIntact).toBe(true);
    expect(failed.claimsFullCoverage).toBe(false);
    expect(failed.failureReason).toBe("provider-timeout");

    const completed = evaluateCurationOutcome({
      summaryStatus: "succeeded",
      processedEntryCount: 4,
      failureReason: null,
    });
    expect(completed.status).toBe("completed");
    expect(completed.claimsFullCoverage).toBe(false);
  });

  it("⑥ 个体隔离：跨个体条目一律拒绝", () => {
    expect(
      evaluateCurationEntryOwnership({
        entryOwnerAgentInstanceId: "agent-1",
        curationAgentInstanceId: "agent-1",
      }).isAllowed,
    ).toBe(true);
    expect(
      evaluateCurationEntryOwnership({
        entryOwnerAgentInstanceId: "agent-2",
        curationAgentInstanceId: "agent-1",
      }).isAllowed,
    ).toBe(false);
  });

  it("⑦ 重启续处理：授权有效且 revision 相符才继续；沿用原游标", () => {
    expect(
      evaluateCurationResume({
        isAuthorizationValid: false,
        authorizedPlanRevision: 1,
        currentPlanRevision: 1,
        committedCursor: 7,
      }),
    ).toMatchObject({ canResume: false, effectiveCursor: 7 });

    expect(
      evaluateCurationResume({
        isAuthorizationValid: true,
        authorizedPlanRevision: 2,
        currentPlanRevision: 3,
        committedCursor: 7,
      }),
    ).toMatchObject({ canResume: false });

    expect(
      evaluateCurationResume({
        isAuthorizationValid: true,
        authorizedPlanRevision: 3,
        currentPlanRevision: 3,
        committedCursor: 7,
      }),
    ).toMatchObject({ canResume: true, effectiveCursor: 7 });
  });

  it("⑧ 运行标识按方案+revision+日期稳定（同输入同 ID）", () => {
    const first = computeCurationRunIdentifier({
      planIdentifier: "plan-1",
      planRevision: 3,
      scheduledLocalDateIso: "2026-10-19",
    });
    const same = computeCurationRunIdentifier({
      planIdentifier: "plan-1",
      planRevision: 3,
      scheduledLocalDateIso: "2026-10-19",
    });
    const otherRevision = computeCurationRunIdentifier({
      planIdentifier: "plan-1",
      planRevision: 4,
      scheduledLocalDateIso: "2026-10-19",
    });
    expect(first).toBe(same);
    expect(first).not.toBe(otherRevision);
  });
});
