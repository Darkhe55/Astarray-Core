/**
 * WIRING-04-03 补口（2026-11-25）：业务消息信封的**受信盖章**。
 *
 * 卡内固定："业务消息的 source/project/taskRevision/executionAttempt 必须由受信执行登记
 * 和发送封装填入，不能从任意模型载荷取得即信任。"
 *
 * 本模块是盖章层的纯判定：
 * - 信封字段**只**取自受信执行登记（registration）；
 * - 载荷自报的字段只能用于**一致性核对**：与登记不一致 ⇒ 拒绝（`draft-claims-mismatch`），
 *   不"以载荷为准"，也不"取两者交集"；
 * - 登记缺字段 ⇒ 拒绝（`registration-incomplete`），不补默认值（尤其不得把 attempt 补成 1）。
 * - 输出信封不含任何模型可写字段。
 */
export interface TrustedExecutionRegistration {
  readonly sourceAgentInstanceIdentifier: string | null;
  readonly projectIdentifier: string | null;
  readonly missionIdentifier: string | null;
  readonly taskIdentifier: string;
  readonly taskRevision: number | null;
  readonly executionAttempt: number | null;
}

export interface FeedbackDraftClaims {
  /** 载荷里可能出现的自报字段；**不可信**，仅用于核对。 */
  readonly sourceAgentInstanceIdentifier?: string | null;
  readonly projectIdentifier?: string | null;
  readonly taskRevision?: number | null;
  readonly executionAttempt?: number | null;
}

export interface SealedFeedbackEnvelope {
  readonly sourceAgentInstanceIdentifier: string;
  readonly projectIdentifier: string;
  readonly taskIdentifier: string;
  readonly taskRevision: number;
  readonly executionAttempt: number;
}

export type SealFeedbackEnvelopeResult =
  | { readonly kind: "sealed"; readonly envelope: SealedFeedbackEnvelope }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "registration-incomplete"
        | "draft-claims-mismatch";
      readonly detail: string;
    };

function isPositiveInteger(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function sealTrustedFeedbackEnvelope(input: {
  readonly registration: TrustedExecutionRegistration;
  readonly draftClaims?: FeedbackDraftClaims;
}): SealFeedbackEnvelopeResult {
  const { registration, draftClaims = {} } = input;

  const source = registration.sourceAgentInstanceIdentifier?.trim() ?? "";
  const project = registration.projectIdentifier?.trim() ?? "";
  if (
    source === "" ||
    project === "" ||
    registration.taskIdentifier.trim() === "" ||
    !isPositiveInteger(registration.taskRevision) ||
    !isPositiveInteger(registration.executionAttempt)
  ) {
    return {
      kind: "rejected",
      reasonCode: "registration-incomplete",
      detail:
        "受信执行登记缺少 source/project/taskRevision/executionAttempt：拒绝盖章，不补默认值。",
    };
  }

  /** 自报字段仅核对：任何一处与登记不同即拒绝（不允许"载荷优先"）。 */
  const claimedSource = draftClaims.sourceAgentInstanceIdentifier ?? null;
  if (claimedSource !== null && claimedSource.trim() !== "" && claimedSource !== source) {
    return {
      kind: "rejected",
      reasonCode: "draft-claims-mismatch",
      detail: `载荷自报来源（${claimedSource}）与受信登记（${source}）不一致。`,
    };
  }
  const claimedProject = draftClaims.projectIdentifier ?? null;
  if (claimedProject !== null && claimedProject.trim() !== "" && claimedProject !== project) {
    return {
      kind: "rejected",
      reasonCode: "draft-claims-mismatch",
      detail: `载荷自报项目（${claimedProject}）与受信登记（${project}）不一致。`,
    };
  }
  if (
    draftClaims.taskRevision !== undefined &&
    draftClaims.taskRevision !== null &&
    draftClaims.taskRevision !== registration.taskRevision
  ) {
    return {
      kind: "rejected",
      reasonCode: "draft-claims-mismatch",
      detail: `载荷自报 taskRevision（${String(draftClaims.taskRevision)}）与受信登记（${String(registration.taskRevision)}）不一致。`,
    };
  }
  if (
    draftClaims.executionAttempt !== undefined &&
    draftClaims.executionAttempt !== null &&
    draftClaims.executionAttempt !== registration.executionAttempt
  ) {
    return {
      kind: "rejected",
      reasonCode: "draft-claims-mismatch",
      detail: `载荷自报 executionAttempt（${String(draftClaims.executionAttempt)}）与受信登记（${String(registration.executionAttempt)}）不一致。`,
    };
  }

  return {
    kind: "sealed",
    envelope: {
      sourceAgentInstanceIdentifier: source,
      projectIdentifier: project,
      taskIdentifier: registration.taskIdentifier,
      taskRevision: registration.taskRevision,
      executionAttempt: registration.executionAttempt,
    },
  };
}
