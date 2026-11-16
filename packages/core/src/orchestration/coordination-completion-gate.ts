/**
 * P1-2（2026-11-17）：**协调完成入口不得绕过权威完成门禁**。
 *
 * 原缺陷：`MainController.applyCoordinationTaskOutcome` 直接调
 * `scheduler.completeTaskByTaskIdentifier → finishTask`，于是"一条带 success 的协调消息"
 * 就能把任务写成 done——绕过了 Worker 收口路径上的完成收据校验与独立审查。
 *
 * 本模块给出**纯判定**（无 IO），由调用方提供权威事实：
 *
 * - 来源必须是该任务的**受派个体**（不是"任意自称成功的人"）；
 * - mission 与 project 必须与当前任务链一致（防跨 mission/跨项目张冠李戴）；
 * - 任务必须仍在执行（`running`），`pending`/终态一律拒绝（旧执行反馈）；
 * - **`done` 必须带完成收据标识**：协调消息的 success 文本、产物存在、退出码 0
 *   都不是验收结论，不足以把任务判成 done；
 * - 评测结论不受协调入口影响：待验收/返修/已验收的任务，一律不接受协调消息改判。
 */
export type CoordinationCompletionCode =
  | "accepted"
  | "source-unknown"
  | "source-not-assignee"
  | "mission-mismatch"
  | "project-mismatch"
  | "task-not-found"
  | "task-not-running"
  | "completion-receipt-required"
  | "review-pending"
  | "review-already-decided";

export interface CoordinationCompletionDecision {
  readonly code: CoordinationCompletionCode;
  readonly isAccepted: boolean;
  readonly reason: string;
}

export function evaluateCoordinationCompletion(input: {
  readonly outcome: "done" | "failed";
  readonly sourceAgentInstanceIdentifier: string | null;
  readonly messageMissionIdentifier: string | null;
  readonly messageProjectIdentifier: string | null;
  readonly task: {
    readonly id: string;
    readonly status: string;
    readonly assignedAgentId: string | null;
    readonly taskType?: string;
  } | null;
  readonly missionProjectIdentifier: string | null;
  /** 完成收据标识（来自 Worker 收口路径；协调消息本身不具备）。 */
  readonly completionReceiptIdentifier: string | null;
  /** 该任务当前的审查状态（由调用方从权威存储读取）。 */
  readonly reviewState: "none" | "pending" | "rework" | "accepted";
  /**
   * 入口种类（2026-11-17）：`worker` 是进程内受派收口，不携带消息侧 mission/project 声明，
   * 因此跳过那两条"消息必须自证"的检查；收据/审查/来源/状态检查照旧。
   */
  readonly entryKind?: "coordination-message" | "worker";
}): CoordinationCompletionDecision {
  const sourceAgentInstanceIdentifier = input.sourceAgentInstanceIdentifier?.trim() ?? "";
  if (sourceAgentInstanceIdentifier === "") {
    return reject("source-unknown", "反馈缺少来源个体标识：无法证明由谁报告完成");
  }
  if (input.entryKind !== "worker" && input.messageMissionIdentifier === null) {
    return reject("mission-mismatch", "反馈未声明所属 mission：不能默认绑定当前 mission");
  }
  if (input.entryKind !== "worker" && input.messageProjectIdentifier === null) {
    return reject("project-mismatch", "反馈未声明所属项目：不能默认绑定当前项目");
  }
  if (input.missionProjectIdentifier !== null && input.messageProjectIdentifier !== input.missionProjectIdentifier) {
    return reject(
      "project-mismatch",
      `反馈项目 ${input.messageProjectIdentifier} 与 mission 项目 ${input.missionProjectIdentifier} 不一致`,
    );
  }
  if (input.task === null) {
    return reject("task-not-found", "任务不在当前任务链里：不新建、不改别的任务");
  }
  if (input.task.status !== "running") {
    return reject(
      "task-not-running",
      `任务当前状态为 ${input.task.status}：只接受仍在执行的反馈（旧执行反馈不得结算）`,
    );
  }
  if (input.task.assignedAgentId === null || input.task.assignedAgentId !== sourceAgentInstanceIdentifier) {
    return reject(
      "source-not-assignee",
      `反馈来源 ${sourceAgentInstanceIdentifier} 不是该任务的受派个体 ${String(input.task.assignedAgentId)}`,
    );
  }

  if (input.outcome === "failed") {
    /** 失败反馈不构成验收，但可以如实推进执行状态。 */
    return accept("失败反馈：按执行失败结算（不涉及验收）");
  }

  /** 以下是 done 的判定：绝不能由"文本说成功"决定。 */
  if (input.reviewState === "pending") {
    return reject("review-pending", "该任务正在独立审查中：协调入口不得改判");
  }
  if (input.reviewState === "rework" || input.reviewState === "accepted") {
    return reject("review-already-decided", "该任务已有审查结论：协调入口不得覆盖");
  }
  if (input.completionReceiptIdentifier === null || input.completionReceiptIdentifier.trim() === "") {
    return reject(
      "completion-receipt-required",
      "缺少完成收据：success 文本/产物存在/退出码 0 都不是验收结论，不能据此判 done",
    );
  }
  return accept("带完成收据且受派来源一致：允许推进执行状态（验收仍由独立审查决定）");
}

/**
 * 审查状态解析（P1-2 补充，2026-11-17）。
 *
 * 必须读**权威裁决存储**，不能只看任务类型：
 * - 已记录 `accepted` ⇒ 通过；`rejected` ⇒ 返修；
 * - 无裁决：审查型任务视为"审查中"，其它任务视为"未进入审查"。
 */
export function resolveReviewStateForCoordination(input: {
  readonly verdict: "accepted" | "rejected" | null;
  readonly taskType: string | null | undefined;
}): "none" | "pending" | "rework" | "accepted" {
  if (input.verdict === "accepted") {
    return "accepted";
  }
  if (input.verdict === "rejected") {
    return "rework";
  }
  return input.taskType === "review" ? "pending" : "none";
}

function reject(code: CoordinationCompletionCode, reason: string): CoordinationCompletionDecision {
  return { code, isAccepted: false, reason };
}

function accept(reason: string): CoordinationCompletionDecision {
  return { code: "accepted", isAccepted: true, reason };
}
