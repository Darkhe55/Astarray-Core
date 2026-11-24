/**
 * RESUME-02（2026-11-24，检查点 03 的 **dispatch 接线**）：把"已领取"交给既有恢复门禁。
 *
 * 纪律：
 * - 领取成功后才调用 `resumeRecoveredMission` 风格的端口，且**显式确认 = 回执本身**
 *   （不是模型/文本自报）；
 * - 对账、重新鉴权、版本复核、权限撤销等门禁由被调端口（核心/SDK）照常执行，本层**不绕过**；
 * - 端口返回 blocked/unknown 时保留领取（可重试），但**不自动重发**、不改目标；
 * - 端口抛错原样上抛（不把失败写成成功）。
 */
import type {
  ContinuationClaim,
  ContinuationClaimResult,
  ContinuationController,
} from "./continuation-controller.js";
import type {
  ContinuationCandidate,
  StructuredContinuationRequest,
} from "./continuation-request.js";

/** 与公开 SDK 的 `resumeRecoveredMission` 对齐的最小端口（注入以避免核心依赖环）。 */
export interface ContinuationResumePort {
  resumeMission(input: {
    readonly missionIdentifier: string;
    readonly hasExplicitUserConfirmation: boolean;
  }): Promise<{
    readonly outcome:
      | "resumed"
      | "recovery-not-explicitly-confirmed"
      | "recovery-reconciliation-required"
      | "recovery-reauthorization-required"
      | "recovery-blocked-by-core";
    readonly missionIdentifier: string;
    readonly recoveredSafeNodes?: readonly string[];
    readonly requiresHandoffIdentity?: boolean;
    readonly requiredReauthorizationTypes?: readonly string[];
    readonly detail?: string;
    readonly blockedDecisionItems?: readonly string[];
  }>;
}

export interface ContinuationDispatchResult {
  readonly status:
    | "resumed"
    | "blocked"
    | ContinuationClaimResult["status"];
  readonly reasonCode: string;
  readonly detail: string | null;
  readonly claim: ContinuationClaim | null;
  readonly recoveredSafeNodes: readonly string[];
  readonly requiredReauthorizationTypes: readonly string[];
  readonly blockedDecisionItems: readonly string[];
}

export class ContinuationDispatchService {
  constructor(
    private readonly options: {
      readonly controller: ContinuationController;
      readonly resumePort: ContinuationResumePort;
    },
  ) {}

  /**
   * 请求 → 领取 → 派发。
   *
   * 已领取（重复请求）时**仍尝试**派发：上一次派发可能失败/被阻塞，重试应复用同一领取与 token，
   * 而不是再领一次。
   */
  async dispatch(input: {
    readonly missionIdentifier: string;
    readonly request: StructuredContinuationRequest | null;
    readonly candidates: readonly ContinuationCandidate[];
    readonly principalIdentifier: string;
    readonly requestIdentifier: string | null;
    readonly nowIso: string;
  }): Promise<ContinuationDispatchResult> {
    const claimResult = await this.options.controller.requestContinuation(input);
    if (
      claimResult.claim === null ||
      (claimResult.status !== "claimed" && claimResult.status !== "already-claimed")
    ) {
      return {
        status: claimResult.status,
        reasonCode: claimResult.reasonCode,
        detail: null,
        claim: claimResult.claim,
        recoveredSafeNodes: [],
        requiredReauthorizationTypes: [],
        blockedDecisionItems: [],
      };
    }

    const resumeOutcome = await this.options.resumePort.resumeMission({
      missionIdentifier: input.missionIdentifier,
      /** 回执本身就是用户的显式确认；本层不给"文本/模型确认"留入口。 */
      hasExplicitUserConfirmation: true,
    });

    if (resumeOutcome.outcome === "resumed") {
      return {
        status: "resumed",
        reasonCode: "resumed",
        detail: null,
        claim: claimResult.claim,
        recoveredSafeNodes: [...(resumeOutcome.recoveredSafeNodes ?? [])],
        requiredReauthorizationTypes: [...(resumeOutcome.requiredReauthorizationTypes ?? [])],
        blockedDecisionItems: [],
      };
    }
    return {
      status: "blocked",
      reasonCode: resumeOutcome.outcome,
      detail: resumeOutcome.detail ?? null,
      claim: claimResult.claim,
      recoveredSafeNodes: [],
      requiredReauthorizationTypes: [...(resumeOutcome.requiredReauthorizationTypes ?? [])],
      blockedDecisionItems: [...(resumeOutcome.blockedDecisionItems ?? [])],
    };
  }
}
