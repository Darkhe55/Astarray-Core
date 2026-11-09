/**
 * ALIGN-03-05（2026-11-09）：**审查证据绑定校验**的通过/拒绝路径。
 *
 * 卡内 2026-10-28 记录"**未跑任何一条拒绝/通过路径**"。本文件补上：
 * 逐条证明"过期或不匹配证据不得合并"，以及"合法证据确实放行"。
 */
import { describe, expect, it, vi } from "vitest";

import {
  assertContributionReviewEvidence,
  evaluateContributionReviewEvidence,
} from "../../../packages/core/src/orchestration/git-review-evidence.js";
import type { GitContributionReviewRecord } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 30_000 });

function buildRecord(
  overrides: Partial<GitContributionReviewRecord> = {},
): GitContributionReviewRecord {
  return {
    contributionIdentifier: "contrib-1",
    taskId: "T-1",
    contributingAgentInstanceId: "worker:task-1",
    reviewingAgentInstanceIdentifier: "reviewer-1",
    baseCommit: "base-sha",
    headCommit: "head-sha",
    changedPaths: ["src/a.ts"],
    reviewDecision: "accepted",
    rejectionReason: null,
    executedChecks: ["unit"],
    ...overrides,
  } as GitContributionReviewRecord;
}

function evaluate(
  record: GitContributionReviewRecord,
  input: {
    readonly isHeadCommitInIntegrationHistory?: boolean;
    readonly requiresReviewer?: boolean;
    readonly expectedTaskIdentifier?: string;
  } = {},
) {
  return evaluateContributionReviewEvidence({
    record,
    expectedTaskIdentifier: input.expectedTaskIdentifier ?? "T-1",
    isHeadCommitInIntegrationHistory: input.isHeadCommitInIntegrationHistory ?? true,
    requiresReviewer: input.requiresReviewer ?? false,
  });
}

describe("ALIGN-03-05 审查证据绑定", () => {
  it("合法证据 ⇒ 放行", () => {
    const evaluation = evaluate(buildRecord());
    expect(evaluation.isAcceptable).toBe(true);
    expect(evaluation.reasons).toEqual([]);
  });

  it("headCommit 不在集成分支历史 ⇒ 拒绝（**过期证据**，这是本卡的核心反例）", () => {
    const evaluation = evaluate(buildRecord(), { isHeadCommitInIntegrationHistory: false });
    expect(evaluation.isAcceptable).toBe(false);
    expect(evaluation.reasons.join("")).toContain("过期");
  });

  it("审查结论非 accepted ⇒ 拒绝，并带出驳回原因", () => {
    const evaluation = evaluate(
      buildRecord({ reviewDecision: "needs-rework", rejectionReason: "缺少测试" }),
    );
    expect(evaluation.isAcceptable).toBe(false);
    expect(evaluation.reasons.join("")).toContain("缺少测试");
  });

  it("任务绑定不一致 ⇒ 拒绝（审的是别的任务）", () => {
    const evaluation = evaluate(buildRecord(), { expectedTaskIdentifier: "T-2" });
    expect(evaluation.isAcceptable).toBe(false);
    expect(evaluation.reasons.join("")).toContain("不一致");
  });

  it("base/head 为空 ⇒ 拒绝（没有可核对的产物版本）", () => {
    expect(evaluate(buildRecord({ headCommit: "  " })).isAcceptable).toBe(false);
    expect(evaluate(buildRecord({ baseCommit: "" })).isAcceptable).toBe(false);
  });

  it("base 与 head 相同 ⇒ 拒绝（没有改动）", () => {
    const evaluation = evaluate(buildRecord({ baseCommit: "same", headCommit: "same" }));
    expect(evaluation.isAcceptable).toBe(false);
    expect(evaluation.reasons.join("")).toContain("相同");
  });

  it("要求审查者但未指定 ⇒ 拒绝（未指定 ≠ 已审查）", () => {
    const evaluation = evaluate(buildRecord({ reviewingAgentInstanceIdentifier: null }), {
      requiresReviewer: true,
    });
    expect(evaluation.isAcceptable).toBe(false);
    expect(evaluation.reasons.join("")).toContain("未指定");
  });

  it("审查者等于贡献者 ⇒ 拒绝（作者不能自审）", () => {
    const evaluation = evaluate(
      buildRecord({
        contributingAgentInstanceId: "same-agent",
        reviewingAgentInstanceIdentifier: "same-agent",
      }),
      { requiresReviewer: true },
    );
    expect(evaluation.isAcceptable).toBe(false);
    expect(evaluation.reasons.join("")).toContain("自审");
  });

  it("不要求审查者时，缺审查者不影响放行（旧报告兼容）", () => {
    const evaluation = evaluate(buildRecord({ reviewingAgentInstanceIdentifier: null }), {
      requiresReviewer: false,
    });
    expect(evaluation.isAcceptable).toBe(true);
  });

  it("多条不合格原因**全部**列出（不只报第一条）", () => {
    const evaluation = evaluate(
      buildRecord({ taskId: "T-9", reviewDecision: "rejected", headCommit: "" }),
      { isHeadCommitInIntegrationHistory: false },
    );
    expect(evaluation.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it("断言版：过期证据抛 `stale-revision`，其它不符抛权限码", () => {
    expect(() =>
      assertContributionReviewEvidence({
        record: buildRecord(),
        expectedTaskIdentifier: "T-1",
        isHeadCommitInIntegrationHistory: false,
        requiresReviewer: false,
      }),
    ).toThrow(/过期|stale/u);
    expect(() =>
      assertContributionReviewEvidence({
        record: buildRecord(),
        expectedTaskIdentifier: "T-2",
        isHeadCommitInIntegrationHistory: true,
        requiresReviewer: false,
      }),
    ).toThrow(/不一致/u);
  });
});
