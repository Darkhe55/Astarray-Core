/**
 * ALIGN-03-05（2026-10-28）：**审查证据绑定校验**。
 *
 * 卡内要求：审查结果要绑定**任务、来源个体、产物 revision/commit、证据与结论**；
 * **过期或不匹配证据不得合并**；人工验收策略按现有配置，本卡不改变批准权。
 *
 * 本模块是纯判定，供 Git 集成收尾（`finalizeIntegration`）在合并前逐条核对：
 *
 * 1. 只有 `accepted` 的贡献可以进入合并（`rejected`/`needs-rework` 一律拦下）；
 * 2. 记录必须绑定**同一个任务**，且 `headCommit` 必须真的**在该集成分支的历史里**
 *    （`git merge-base --is-ancestor` 由调用方探测后传入）—— 否则"审查过的东西"
 *    与实际要合并的东西不是同一份，属于过期/不匹配证据；
 * 3. 两侧 commit 必须存在（空提交范围的审查结论没有可核对产物）；
 * 4. 需要审查者时（`requiresReviewer`），审查者必须**存在且不等于贡献者**
 *    —— 缺省 `null` 表示"未指定"，**不得**当作已审查。
 *
 * 不改变批准权：人工验收/合并授权仍由既有五门禁与用户配置决定，本模块只看证据一致性。
 */
import { DomainError } from "../core/errors.js";
import type { GitContributionReviewRecord } from "../core/types.js";

export interface EvaluateContributionReviewEvidenceInput {
  readonly record: GitContributionReviewRecord;
  /** 期望的任务标识（与记录不一致即拒绝）。 */
  readonly expectedTaskIdentifier: string;
  /** `headCommit` 是否已在集成分支历史中（调用方用 git 探测）。 */
  readonly isHeadCommitInIntegrationHistory: boolean;
  /** 是否要求审查者（缺省 false：旧报告没有该字段）。 */
  readonly requiresReviewer: boolean;
}

export interface ContributionReviewEvidenceEvaluation {
  readonly isAcceptable: boolean;
  readonly reasons: readonly string[];
}

/** 逐条核对一条贡献审查记录；返回不可合并的具体原因（不抛错，便于汇总）。 */
export function evaluateContributionReviewEvidence(
  input: EvaluateContributionReviewEvidenceInput,
): ContributionReviewEvidenceEvaluation {
  const reasons: string[] = [];
  const record = input.record;
  if (record.reviewDecision !== "accepted") {
    reasons.push(
      `审查结论为 ${record.reviewDecision}（只有 accepted 可进入合并）` +
        (record.rejectionReason === null ? "" : `：${record.rejectionReason}`),
    );
  }
  if (record.taskId !== input.expectedTaskIdentifier) {
    reasons.push(
      `审查记录绑定任务 ${record.taskId} 与待合并任务 ${input.expectedTaskIdentifier} 不一致`,
    );
  }
  if (record.baseCommit.trim() === "" || record.headCommit.trim() === "") {
    reasons.push("审查记录缺少 base/head commit，无法确认被审查的产物版本");
  }
  if (
    record.baseCommit.trim() !== "" &&
    record.baseCommit === record.headCommit
  ) {
    reasons.push("审查记录的 base 与 head 相同：没有可核对的改动");
  }
  if (!input.isHeadCommitInIntegrationHistory) {
    reasons.push(
      "审查记录的 headCommit 不在集成分支历史中：被审查的产物与实际要合并的内容不一致（过期证据）",
    );
  }
  if (input.requiresReviewer) {
    const reviewer = record.reviewingAgentInstanceIdentifier ?? null;
    if (reviewer === null || reviewer.trim() === "") {
      reasons.push("缺少审查者：未指定审查者的贡献不得合并（未指定 ≠ 已审查）");
    } else if (reviewer === record.contributingAgentInstanceId) {
      reasons.push("审查者与贡献者是同一个个体的记录不得合并（作者不能自审）");
    }
  }
  return { isAcceptable: reasons.length === 0, reasons };
}

/**
 * 供调用方在**准备合并前**做断言；错误码区分"证据过期"与"权限/来源不符"。
 */
export function assertContributionReviewEvidence(
  input: EvaluateContributionReviewEvidenceInput,
): void {
  const evaluation = evaluateContributionReviewEvidence(input);
  if (evaluation.isAcceptable) {
    return;
  }
  const isStale = evaluation.reasons.some(
    (reason) => reason.includes("过期") || reason.includes("不在集成分支历史"),
  );
  throw new DomainError(
    isStale ? "stale-revision" : "task-sequence-permission-denied",
    `贡献审查证据不可用于合并：${evaluation.reasons.join("；")}`,
  );
}
