/**
 * RESUME-02 **实验性并行层**（2026-11-24）：把显式请求的"已领取"交给既有恢复门禁。
 *
 * 与产品路径的关系：产品入口是断点驱动（见 `continuation-breakpoint.ts` 与门面方法）；
 * 本服务仅供实验/宿主自组装，不进入公开 SDK。
 *
 * 纪律：
 * - 领取成功后才调用 `resumeRecoveredMission` 风格的端口，且**显式确认 = 回执本身**
 *   （不是模型/文本自报）；
 * - 对账、重新鉴权、版本复核、权限撤销等门禁由被调端口（核心/SDK）照常执行，本层**不绕过**；
 * - 端口返回 blocked/unknown 时保留领取（可重试），但**不自动重发**、不改目标；
 * - 端口抛错原样上抛（不把失败写成成功）。
 */
import type {
  CheckpointContinuationController,
  ContinuationClaim,
  ContinuationClaimResult,
} from "./continuation-controller.js";
import type {
  ContinuationCandidate,
  StructuredContinuationRequest,
} from "./continuation-request.js";
import type {
  ContinuationMetricOutcome,
  ContinuationMetrics,
} from "./continuation-metrics.js";

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

export class CheckpointContinuationDispatchService {
  constructor(
    private readonly options: {
      readonly controller: CheckpointContinuationController;
      readonly resumePort: ContinuationResumePort;
      /** RESUME-02 观测：可选注入；不传则不计（测试/嵌入方不被迫接入）。 */
      readonly metrics?: ContinuationMetrics;
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
      this.options.metrics?.record({
        outcome: this.toMetricOutcome(claimResult.status),
        reasonCode: claimResult.reasonCode,
      });
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
      this.options.metrics?.record({ outcome: "resumed", reasonCode: "resumed" });
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
    this.options.metrics?.record({
      outcome: "blocked",
      reasonCode: resumeOutcome.outcome,
    });
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

  /** claimResult.status 与指标枚举对齐（未知状态归 unknown，不抛错、不丢计数）。 */
  private toMetricOutcome(status: string): ContinuationMetricOutcome {
    const known = new Set([
      "claimed",
      "already-claimed",
      "still-running",
      "needs-selection",
      "needs-answer",
      "needs-authorization",
      "reconciling",
      "nothing-to-resume",
      "disabled",
      "cancelled",
    ]);
    return (known.has(status) ? status : "unknown") as never;
  }
}
