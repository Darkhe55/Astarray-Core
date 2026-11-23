/**
 * COORD-05 05-04（2026-11-23）：**秘书通道端口**。
 *
 * 秘书是否"已激活"与如何投递都由宿主注入——仓库内没有权威的秘书激活状态，
 * 这里不猜、不默认开启：
 * - `isActivated()` 为假 ⇒ 拒绝呈交（submitDecision 记为 channel-unavailable，记录保持待呈交）；
 * - `dispatch()` 抛错 ⇒ 同上（不伪造回执）；
 * - 成功 ⇒ 返回真实回执标识，呈交记录据此可追溯。
 */
import type { DecisionChannelPort } from "./decision-submission.js";

export interface SecretaryDecisionDispatchInput {
  readonly submissionIdentifier: string;
  readonly projectIdentifier: string;
  readonly decisionId: string;
  readonly ownerAgentInstanceId: string;
  readonly taskIdentifier: string;
  readonly summary: string;
  readonly recommendedReason: string | null;
  readonly affectedStepIdentifiers: readonly string[];
  readonly candidates: ReadonlyArray<{
    readonly candidateIdentifier: string;
    readonly label: string;
    readonly value: string;
  }>;
}

export interface SecretaryDecisionDispatcher {
  dispatch(input: SecretaryDecisionDispatchInput): Promise<{ readonly receiptIdentifier: string }>;
}

export function createSecretaryDecisionChannel(options: {
  /** 与 `submitDecision` 的 `isSecretaryActivated` 必须是**同一权威来源**（由宿主注入）。 */
  readonly isActivated: () => boolean | Promise<boolean>;
  readonly dispatcher: SecretaryDecisionDispatcher;
}): DecisionChannelPort {
  return {
    submit: async (input) => {
      const activated = await options.isActivated();
      if (!activated) {
        throw new Error("秘书未激活：拒绝呈交（不默认开启、不伪造回执）。");
      }
      if (input.ownerAgentInstanceId === undefined || input.ownerAgentInstanceId.trim() === "") {
        throw new Error("秘书通道需要明确提交方（ownerAgentInstanceId）。");
      }
      if (input.taskIdentifier === undefined || input.taskIdentifier.trim() === "") {
        throw new Error("秘书通道需要明确任务标识（taskIdentifier）。");
      }
      const receipt = await options.dispatcher.dispatch({
        submissionIdentifier: input.submissionIdentifier,
        projectIdentifier: input.projectIdentifier,
        decisionId: input.decisionId,
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        taskIdentifier: input.taskIdentifier,
        summary: input.summary,
        recommendedReason: input.recommendedReason,
        affectedStepIdentifiers: input.affectedStepIdentifiers,
        candidates: input.candidates,
      });
      if (receipt.receiptIdentifier.trim() === "") {
        throw new Error("秘书通道返回空回执：拒绝伪造成功。");
      }
      return { receiptIdentifier: receipt.receiptIdentifier };
    },
  };
}
