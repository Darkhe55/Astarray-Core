/**
 * COORD-05 05-04×05-05 接线（2026-11-22）：**用户答复 → 决定写回 → 任务链证据**。
 *
 * 把三件事接成一条产品路径：
 * 1. `DecisionSubmissionStore` 校验答复与原项目/原请求匹配（未呈交不可答复）；
 * 2. 以**同一决定 ID**登记写回记录并调用 `applyDecisionWriteback`；
 * 3. 写回落到真实任务链（追加 `decisionApplicationEvidence`），并只推进显式依赖该决定的步骤。
 *
 * 本模块不做 UI/通道；秘书/用户通道由 05-04 的端口层负责。
 */
import type { TaskStore } from "../infra/task-store.js";
import type {
  DecisionSubmissionStore,
  DecisionSubmissionRecord,
} from "./decision-submission.js";
import {
  applyDecisionWriteback,
  type DecisionWritebackOutcome,
  type DecisionWritebackStore,
} from "./decision-writeback.js";
import { createTaskChainDecisionPorts } from "./task-chain-decision-ports.js";

export interface DecisionApplicationDeps {
  readonly submissionStore: DecisionSubmissionStore;
  readonly writebackStore: DecisionWritebackStore;
  readonly taskStore: TaskStore;
  /** 调度器推进：curried mission 便于适配器只传 stepId。 */
  readonly advanceStep: (missionIdentifier: string, stepIdentifier: string) => Promise<void>;
  readonly resolveMissionStatus?: (
    missionIdentifier: string,
  ) => Promise<"running" | "cancelled" | "completed" | "unknown">;
  readonly nowIso?: () => string;
}

export interface ApplyUserDecisionInput {
  readonly submissionIdentifier: string;
  readonly projectIdentifier: string;
  readonly answer: string;
  readonly answeredAtIso: string;
  /** 呈交记录未存 mission/task；由调用方从请示记录带入（不得猜测）。 */
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly escalationRequestIdentifier?: string | null;
}

export type ApplyUserDecisionOutcome =
  | {
      readonly kind: "applied" | "duplicate";
      readonly submission: DecisionSubmissionRecord;
      readonly writeback: DecisionWritebackOutcome;
      readonly advancedSteps: ReadonlyArray<string>;
    }
  | {
      readonly kind: "refused";
      readonly code:
        | "submission-not-found"
        | "project-mismatch"
        | "not-submitted"
        | "writeback-deferred"
        | "writeback-conflict"
        | "mission-cancelled";
      readonly reason: string;
    };

export async function applyUserDecision(
  deps: DecisionApplicationDeps,
  input: ApplyUserDecisionInput,
): Promise<ApplyUserDecisionOutcome> {
  const answered = await deps.submissionStore.markAnswered({
    submissionIdentifier: input.submissionIdentifier,
    projectIdentifier: input.projectIdentifier,
    answer: input.answer,
    answeredAtIso: input.answeredAtIso,
  });
  if (answered.kind === "refused") {
    return {
      kind: "refused",
      code:
        answered.code === "not-found"
          ? "submission-not-found"
          : answered.code === "project-mismatch"
            ? "project-mismatch"
            : "not-submitted",
      reason: answered.reason,
    };
  }
  const submission = answered.record;

  /** 写回记录与呈交记录使用**同一决定 ID**（重复答复不产生第二条）。 */
  const existing = (await deps.writebackStore.list()).find(
    (record) => record.decisionIdentifier === submission.decisionId,
  );
  if (existing === undefined) {
    await deps.writebackStore.recordAnswer({
      decisionIdentifier: submission.decisionId,
      escalationRequestIdentifier:
        input.escalationRequestIdentifier ?? submission.submissionIdentifier,
      projectIdentifier: submission.projectIdentifier,
      missionIdentifier: input.missionIdentifier,
      taskIdentifier: input.taskIdentifier,
      source: "user",
      summary: submission.summary,
      affectedStepIdentifiers: submission.affectedStepIdentifiers,
      status: "answered",
      documentRevision: null,
      advancedStepIdentifiers: [],
      createdAtIso: input.answeredAtIso,
      updatedAtIso: input.answeredAtIso,
    });
  }

  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const ports = createTaskChainDecisionPorts({
    store: deps.taskStore,
    missionIdentifier: input.missionIdentifier,
    advanceStep: (stepIdentifier) =>
      deps.advanceStep(input.missionIdentifier, stepIdentifier),
    ...(deps.resolveMissionStatus === undefined
      ? {}
      : { resolveMissionStatus: deps.resolveMissionStatus }),
    nowIso,
  });
  const writeback = await applyDecisionWriteback(
    { store: deps.writebackStore, ports },
    { decisionIdentifier: submission.decisionId, nowIso: nowIso() },
  );
  if (writeback.kind === "cancelled") {
    return {
      kind: "refused",
      code: "mission-cancelled",
      reason: "mission 已取消：迟到的答复不重启任务。",
    };
  }
  if (writeback.kind === "deferred") {
    return { kind: "refused", code: "writeback-deferred", reason: writeback.reason };
  }
  if (writeback.kind === "conflict") {
    return { kind: "refused", code: "writeback-conflict", reason: writeback.reason };
  }
  return {
    kind: writeback.kind === "duplicate" ? "duplicate" : "applied",
    submission,
    writeback,
    advancedSteps: writeback.kind === "advanced" ? writeback.advancedSteps : [],
  };
}
