/**
 * ALIGN-03-01：**独立验收闭环的状态机与守卫**（2026-11-10）。
 *
 * 背景（用户裁决）：产物"存在且非空"**不能**直接等价于 `merge-ready`。
 * 产物存在性只是**送审前置条件**，独立验收必须由**真实审查任务**产出裁决。
 * 因此本模块把两件事分开：
 *
 *  1. `checkOutputArtifact`（另一模块）—— 产物是否存在/非空/在项目根内，属**前置检查**；
 *  2. 独立验收 —— 必须有**已完成的审查任务** + **带证据的裁决**。
 *
 * 同时明确四个状态的关系（不得互相冒充）：
 *
 *   执行完成(execution-done) ──派发审查任务──▶ 待验收(pending-acceptance)
 *        ▲                                            │
 *        │                                       裁决 rework
 *        └────────── 返修(rework) ◀──────────────────┤
 *                                                     │
 *                                          裁决 merge-ready
 *                                                     ▼
 *                                            验收通过(accepted)
 *
 * 三条硬约束（对应用户明确禁止的事项）：
 *  - **仅登记审查者身份**不等于完成独立审查（`reviewer-registration-is-not-review`）；
 *  - 审查任务未完成时**不得**进入 `accepted`（`review-task-not-completed`）；
 *  - 裁决无证据时**不得**进入 `accepted`（`verdict-evidence-missing`）；
 *  - 只有 `accepted` 允许对外宣称"任务最终完成"（`isFinalCompletionAllowed`）。
 */

/** 任务验收状态（与任务存储的 `TaskStatus` 分开：后者只描述执行进度）。 */
export type TaskAcceptanceState =
  | "execution-done"
  | "pending-acceptance"
  | "rework"
  | "accepted";

/** 独立验收被阻断的原因码。 */
export type IndependentReviewBlockReasonCode =
  | "reviewer-registration-is-not-review"
  | "review-task-not-completed"
  | "verdict-missing"
  | "verdict-evidence-missing"
  | "verdict-rejected";

export interface IndependentReviewOutcome {
  /** 审查任务标识；**仅登记身份而没有审查任务**时为空。 */
  readonly reviewTaskIdentifier: string | null;
  /** 审查任务的执行状态（任务存储口径）。 */
  readonly reviewTaskStatus: "pending" | "running" | "blocked" | "done" | "failed" | null;
  /** 审查任务产出的裁决；未产出时为空。 */
  readonly verdict: "merge-ready" | "rework" | null;
  /** 裁决证据（必须是可复核引用，如 `artifact:` / `check:` / `commit:` / `test:`）。 */
  readonly evidenceReferences: readonly string[];
}

export interface TaskAcceptanceStateInput {
  /** 产物前置检查是否通过（存在、非空、在项目根内）。 */
  readonly isArtifactPreconditionSatisfied: boolean;
  /** 独立审查结果；尚未派发审查任务时为空。 */
  readonly reviewOutcome: IndependentReviewOutcome | null;
}

/**
 * 推导验收状态。**纯函数**：不读存储、不猜时间。
 *
 * 顺序很重要：
 *  1. 产物前置不满足 ⇒ 直接 `rework`（连送审资格都没有）；
 *  2. 没有审查结果 / 没有审查任务 ⇒ `execution-done`（**不是** accepted）；
 *  3. 审查任务未完成 ⇒ `pending-acceptance`；
 *  4. 有裁决 ⇒ 按裁决给出 `accepted` 或 `rework`；证据缺失时**降级为** `pending-acceptance`。
 */
export function deriveTaskAcceptanceState(
  input: TaskAcceptanceStateInput,
): TaskAcceptanceState {
  if (!input.isArtifactPreconditionSatisfied) {
    return "rework";
  }
  const reviewOutcome = input.reviewOutcome;
  if (reviewOutcome === null) {
    return "execution-done";
  }
  if (
    reviewOutcome.reviewTaskIdentifier === null ||
    reviewOutcome.reviewTaskIdentifier.trim() === ""
  ) {
    /** 只登记了审查者身份、没有真实审查任务 ⇒ 停在执行完成。 */
    return "execution-done";
  }
  if (reviewOutcome.reviewTaskStatus !== "done") {
    return "pending-acceptance";
  }
  if (reviewOutcome.verdict === null) {
    return "pending-acceptance";
  }
  if (reviewOutcome.verdict === "rework") {
    return "rework";
  }
  /** merge-ready 但无证据 ⇒ 不能算通过。 */
  if (reviewOutcome.evidenceReferences.length === 0) {
    return "pending-acceptance";
  }
  return "accepted";
}

export interface IndependentReviewEvaluation {
  readonly acceptanceState: TaskAcceptanceState;
  readonly blockReasonCodes: readonly IndependentReviewBlockReasonCode[];
}

/**
 * 评估独立验收是否真的闭合，并给出**全部**阻断原因（不覆盖、不只报第一条）。
 */
export function evaluateIndependentReview(
  input: TaskAcceptanceStateInput,
): IndependentReviewEvaluation {
  const acceptanceState = deriveTaskAcceptanceState(input);
  const blockReasonCodes: IndependentReviewBlockReasonCode[] = [];
  const reviewOutcome = input.reviewOutcome;
  if (reviewOutcome !== null) {
    if (
      reviewOutcome.reviewTaskIdentifier === null ||
      reviewOutcome.reviewTaskIdentifier.trim() === ""
    ) {
      blockReasonCodes.push("reviewer-registration-is-not-review");
    } else if (reviewOutcome.reviewTaskStatus !== "done") {
      blockReasonCodes.push("review-task-not-completed");
    } else if (reviewOutcome.verdict === null) {
      blockReasonCodes.push("verdict-missing");
    } else if (reviewOutcome.verdict === "rework") {
      blockReasonCodes.push("verdict-rejected");
    } else if (reviewOutcome.evidenceReferences.length === 0) {
      blockReasonCodes.push("verdict-evidence-missing");
    }
  }
  return { acceptanceState, blockReasonCodes };
}

/**
 * 只有 `accepted` 允许对外宣称"任务最终完成"。
 *
 * 用户明确要求：**审查失败后不得向用户宣称任务最终完成**。
 * 因此待验收 / 返修 / 执行完成都返回 false。
 */
export function isFinalCompletionAllowed(acceptanceState: TaskAcceptanceState): boolean {
  return acceptanceState === "accepted";
}

/**
 * 对外文案：状态到用户可见措辞的唯一映射（避免各处自行编造"已完成"）。
 */
export function describeAcceptanceState(acceptanceState: TaskAcceptanceState): string {
  switch (acceptanceState) {
    case "execution-done":
      return "执行完成（尚未送审）";
    case "pending-acceptance":
      return "待验收（审查中）";
    case "rework":
      return "返修";
    case "accepted":
      return "验收通过";
  }
}
