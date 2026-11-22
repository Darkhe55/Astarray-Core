/**
 * COORD-05 05-04（2026-11-22）：**直接用户通道**——把决策摘要登记为用户待决记录。
 *
 * 复用 05-03 的 `UserClarificationStore`（不是第二条用户问题通道）：
 * - `sourceRequestIdentifier = submissionIdentifier` ⇒ 重试/恢复只生成一条待决事项；
 * - 候选、影响面、推荐理由、受阻步骤原样带入；
 * - 回执标识 = 澄清记录标识（呈交记录据此可追溯）。
 *
 * 通道自身不做 UI；用户在 TUI/GUI 的答复仍走既有澄清答复入口。
 */
import type { DecisionChannelPort } from "./decision-submission.js";
import type { UserClarificationStore } from "./user-clarification.js";

export function createClarificationUserChannel(options: {
  readonly store: UserClarificationStore;
  readonly nowIso?: () => string;
}): DecisionChannelPort {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  return {
    submit: async (input) => {
      if (input.ownerAgentInstanceId === undefined || input.ownerAgentInstanceId.trim() === "") {
        throw new Error("直接用户通道需要明确提交方（ownerAgentInstanceId）。");
      }
      if (input.taskIdentifier === undefined || input.taskIdentifier.trim() === "") {
        throw new Error("直接用户通道需要明确任务标识（taskIdentifier）。");
      }
      const record = await options.store.register({
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        taskIdentifier: input.taskIdentifier,
        projectIdentifier: input.projectIdentifier,
        questionText: input.summary,
        candidates: input.candidates.map((candidate) => ({
          candidateIdentifier: candidate.candidateIdentifier,
          label: candidate.label,
          value: candidate.value,
        })),
        allowFreeformInput: true,
        sourceRequestIdentifier: input.submissionIdentifier,
        createdAtIso: nowIso(),

        ...(input.recommendedReason === null
          ? {}
          : { recommendedReason: input.recommendedReason }),
        blockedStepIdentifiers: input.affectedStepIdentifiers,
      });
      return { receiptIdentifier: record.clarificationIdentifier };
    },
  };
}
