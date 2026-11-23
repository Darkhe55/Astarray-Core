/**
 * RESUME-02（2026-11-24 首版，检查点 01–03 的**本地判定层**）：
 * 断点续接的显式请求适配——配置默认关闭、状态由本地权威记录推导、回执短期有效。
 *
 * 纪律（卡内原文）：
 * - 不解析自然语言、不调用模型：普通"继续"保留对话语义；本模块**只**接受结构化请求；
 * - 所有操作执行时重新校验状态与版本；回执只满足"请求恢复这个任务"的确认，
 *   不提供工具/外发/安装授权（对账、重新鉴权等门禁照常执行）；
 * - 缺失/损坏配置按关闭处理（fail-closed）。
 */
export type ContinuationResolutionStatus =
  | "disabled"
  | "still-running"
  | "needs-selection"
  | "needs-answer"
  | "needs-authorization"
  | "paused"
  | "completed"
  | "cancelled"
  | "reconciling"
  | "waiting-provider"
  | "resumable"
  | "nothing-to-resume";

export interface CheckpointContinuationSetting {
  readonly isEnabled: boolean;
  readonly reason: "enabled" | "config-missing" | "config-invalid" | "config-disabled";
}

/** 配置只认**显式 true**；缺失/损坏/非布尔一律关闭。 */
export function resolveCheckpointContinuationSetting(input: {
  readonly configuredValue: unknown;
}): CheckpointContinuationSetting {
  if (input.configuredValue === undefined || input.configuredValue === null) {
    return { isEnabled: false, reason: "config-missing" };
  }
  if (typeof input.configuredValue !== "boolean") {
    return { isEnabled: false, reason: "config-invalid" };
  }
  return input.configuredValue
    ? { isEnabled: true, reason: "enabled" }
    : { isEnabled: false, reason: "config-disabled" };
}

export type ContinuationTaskState =
  | "running"
  | "awaiting-answer"
  | "awaiting-authorization"
  | "paused"
  | "completed"
  | "cancelled"
  | "started-unknown"
  | "planned";

export interface ContinuationCandidate {
  readonly taskIdentifier: string;
  readonly projectIdentifier: string;
  readonly taskState: ContinuationTaskState;
  /** 目标任务的当前权威 revision（用于与请求的 expectedRevision 对账）。 */
  readonly revision: number;
}

export interface StructuredContinuationRequest {
  readonly requestIdentifier: string;
  readonly projectIdentifier: string;
  readonly conversationIdentifier: string | null;
  readonly taskIdentifier: string;
  readonly expectedRevision: number;
}

export interface ContinuationEvaluation {
  readonly status: ContinuationResolutionStatus;
  readonly reasonCode: string;
  /** 本地权威记录推导出的候选（为空时不给猜测性建议）。 */
  readonly candidateTaskIdentifiers: readonly string[];
}

/**
 * 由本地权威记录推导状态。**不触发恢复、不派发、不写状态**。
 *
 * 若 `requestIdentifier` 已登记但目标任务仍在运行 ⇒ still-running（不重复派发）。
 */
export function evaluateContinuationRequest(input: {
  readonly setting: CheckpointContinuationSetting;
  readonly request: StructuredContinuationRequest | null;
  readonly candidates: readonly ContinuationCandidate[];
}): ContinuationEvaluation {
  if (!input.setting.isEnabled) {
    return {
      status: "disabled",
      reasonCode: input.setting.reason === "enabled" ? "disabled" : input.setting.reason,
      candidateTaskIdentifiers: [],
    };
  }
  const request = input.request;
  if (request === null) {
    return {
      status: "needs-selection",
      reasonCode: "target-not-specified",
      candidateTaskIdentifiers: input.candidates.map((candidate) => candidate.taskIdentifier),
    };
  }
  /** 作用域：只认请求所属项目内的候选，不跨项目猜测。 */
  const inProject = input.candidates.filter(
    (candidate) => candidate.projectIdentifier === request.projectIdentifier,
  );
  if (inProject.length === 0) {
    return {
      status: "nothing-to-resume",
      reasonCode: "no-candidate-in-project",
      candidateTaskIdentifiers: [],
    };
  }
  const matched = inProject.filter(
    (candidate) => candidate.taskIdentifier === request.taskIdentifier,
  );
  if (matched.length === 0) {
    return {
      status: "needs-selection",
      reasonCode: "target-not-found-in-project",
      candidateTaskIdentifiers: inProject.map((candidate) => candidate.taskIdentifier),
    };
  }
  if (matched.length > 1) {
    return {
      status: "needs-selection",
      reasonCode: "ambiguous-target",
      candidateTaskIdentifiers: matched.map((candidate) => candidate.taskIdentifier),
    };
  }
  const candidate = matched[0]!;
  if (candidate.revision !== request.expectedRevision) {
    return {
      status: "reconciling",
      reasonCode: "revision-changed",
      candidateTaskIdentifiers: [candidate.taskIdentifier],
    };
  }
  switch (candidate.taskState) {
    case "running":
      return { status: "still-running", reasonCode: "still-running", candidateTaskIdentifiers: [candidate.taskIdentifier] };
    case "awaiting-answer":
      return { status: "needs-answer", reasonCode: "question-pending", candidateTaskIdentifiers: [candidate.taskIdentifier] };
    case "awaiting-authorization":
      return {
        status: "needs-authorization",
        reasonCode: "authorization-pending",
        candidateTaskIdentifiers: [candidate.taskIdentifier],
      };
    case "paused":
      return { status: "paused", reasonCode: "paused-by-human", candidateTaskIdentifiers: [candidate.taskIdentifier] };
    case "completed":
      return { status: "completed", reasonCode: "already-completed", candidateTaskIdentifiers: [candidate.taskIdentifier] };
    case "cancelled":
      return { status: "cancelled", reasonCode: "already-cancelled", candidateTaskIdentifiers: [candidate.taskIdentifier] };
    case "started-unknown":
      return {
        status: "reconciling",
        reasonCode: "result-unknown",
        candidateTaskIdentifiers: [candidate.taskIdentifier],
      };
    case "planned":
      return { status: "resumable", reasonCode: "checkpoint-confirmed-not-executed", candidateTaskIdentifiers: [candidate.taskIdentifier] };
  }
}

export interface ResumeIntentReceipt {
  readonly receiptIdentifier: string;
  readonly requestIdentifier: string;
  readonly principalIdentifier: string;
  readonly projectIdentifier: string;
  readonly conversationIdentifier: string | null;
  readonly taskIdentifier: string;
  readonly expectedRevision: number;
  readonly sourceChannel: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
}

export const RESUME_INTENT_RECEIPT_VALIDITY_MILLISECONDS = 5 * 60 * 1000;

/** 登记恢复意图回执（首版 5 分钟有效；只作"用户确认恢复该任务"的证据）。 */
export function issueResumeIntentReceipt(input: {
  readonly receiptIdentifier: string;
  readonly request: StructuredContinuationRequest;
  readonly principalIdentifier: string;
  readonly sourceChannel: string;
  readonly nowIso: string;
}): ResumeIntentReceipt {
  const issuedAtMilliseconds = Date.parse(input.nowIso);
  if (Number.isNaN(issuedAtMilliseconds)) {
    throw new Error("issueResumeIntentReceipt: 非法时间");
  }
  return {
    receiptIdentifier: input.receiptIdentifier,
    requestIdentifier: input.request.requestIdentifier,
    principalIdentifier: input.principalIdentifier,
    projectIdentifier: input.request.projectIdentifier,
    conversationIdentifier: input.request.conversationIdentifier,
    taskIdentifier: input.request.taskIdentifier,
    expectedRevision: input.request.expectedRevision,
    sourceChannel: input.sourceChannel,
    issuedAtIso: new Date(issuedAtMilliseconds).toISOString(),
    expiresAtIso: new Date(
      issuedAtMilliseconds + RESUME_INTENT_RECEIPT_VALIDITY_MILLISECONDS,
    ).toISOString(),
  };
}

/**
 * 执行前复核回执：过期/主体/目标/版本不一致都拒绝，**不**把旧回执换新许可。
 * 返回原因码而非抛错，便于 CLI/SDK 如实呈现。
 */
export function validateResumeIntentReceipt(input: {
  readonly receipt: ResumeIntentReceipt;
  readonly principalIdentifier: string;
  readonly taskIdentifier: string;
  readonly expectedRevision: number;
  readonly nowIso: string;
}): { readonly isValid: boolean; readonly reasonCode: string | null } {
  const nowMilliseconds = Date.parse(input.nowIso);
  if (Number.isNaN(nowMilliseconds) || nowMilliseconds >= Date.parse(input.receipt.expiresAtIso)) {
    return { isValid: false, reasonCode: "receipt-expired" };
  }
  if (input.receipt.principalIdentifier !== input.principalIdentifier) {
    return { isValid: false, reasonCode: "principal-mismatch" };
  }
  if (input.receipt.taskIdentifier !== input.taskIdentifier) {
    return { isValid: false, reasonCode: "target-mismatch" };
  }
  if (input.receipt.expectedRevision !== input.expectedRevision) {
    return { isValid: false, reasonCode: "revision-changed" };
  }
  return { isValid: true, reasonCode: null };
}
