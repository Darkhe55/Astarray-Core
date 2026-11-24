/**
 * RESUME-02 **实验性并行层**（2026-11-24）：显式请求的本地对账 + 原子领取。
 *
 * 注意：用户裁决的 RESUME-02 产品路径是**断点驱动**（`continuation-breakpoint.ts` 的
 * `ContinuationController` / 门面 `queryContinuationBreakpoints` / `requestContinuation`）。
 * 本类不进入公开 SDK，只作为显式请求判定与诊断的实验层；类名加 `Checkpoint` 前缀以区分。
 *
 * 流程：validate-request → reconcile（状态由本地权威记录推导）→ claim（单调 revision + fencing token）
 * → 返回"可派发/不可派发"。**不派发 worker、不装配上下文**；这两步的接线仍在卡内未完成。
 *
 * 纪律：
 * - 只接受已登记且复核通过的回执；回执只证明"用户确认恢复该任务"；
 * - 领取带 fencing token：旧的领取者提交时用 token 复核，过期/被取代即拒绝；
 * - 重复请求幂等：同一请求 + 同版本 ⇒ 同一领取与同一 token。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  CheckpointContinuationSetting,
  ContinuationCandidate,
  ContinuationResolutionStatus,
  StructuredContinuationRequest,
} from "./continuation-request.js";
import { evaluateContinuationRequest } from "./continuation-request.js";
import type { ResumeIntentReceiptStore } from "./continuation-receipt-store.js";

export const CONTINUATION_CLAIM_SCHEMA_VERSION = 1;
export const CONTINUATION_CLAIM_LEASE_MILLISECONDS = 2 * 60 * 1000;

export interface ContinuationClaim {
  readonly claimIdentifier: string;
  readonly requestIdentifier: string;
  readonly projectIdentifier: string;
  readonly taskIdentifier: string;
  readonly expectedRevision: number;
  /** 单调递增；每次新的领取 +1，旧 token 立即失效（fencing）。 */
  readonly fencingToken: number;
  readonly claimedAtIso: string;
  readonly expiresAtIso: string;
}

interface ContinuationClaimDocument {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly claims: readonly ContinuationClaim[];
}

export interface ContinuationClaimResult {
  readonly status: ContinuationResolutionStatus | "claimed" | "already-claimed" | "claim-conflict";
  readonly reasonCode: string;
  readonly claim: ContinuationClaim | null;
  readonly candidateTaskIdentifiers: readonly string[];
}

export class CheckpointContinuationController {
  private readonly claimFilePath: string;

  constructor(
    private readonly options: {
      readonly baseDirectory: string;
      readonly receiptStore: ResumeIntentReceiptStore;
      readonly setting: CheckpointContinuationSetting;
    },
  ) {
    this.claimFilePath = path.join(options.baseDirectory, "continuation", "claims.json");
  }

  private async readClaims(): Promise<ContinuationClaimDocument> {
    try {
      const content = await fs.readFile(this.claimFilePath, "utf8");
      const parsed = JSON.parse(content) as Partial<ContinuationClaimDocument>;
      return {
        schemaVersion: parsed.schemaVersion ?? CONTINUATION_CLAIM_SCHEMA_VERSION,
        revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        claims: Array.isArray(parsed.claims) ? (parsed.claims as ContinuationClaim[]) : [],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { schemaVersion: CONTINUATION_CLAIM_SCHEMA_VERSION, revision: 0, claims: [] };
      }
      /** 损坏 ⇒ 无有效领取（fail-closed：旧执行者不能凭坏数据继续提交）。 */
      return { schemaVersion: CONTINUATION_CLAIM_SCHEMA_VERSION, revision: 0, claims: [] };
    }
  }

  private async writeClaims(document: ContinuationClaimDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.claimFilePath), { recursive: true });
    await fs.writeFile(
      this.claimFilePath,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
  }

  private isActive(claim: ContinuationClaim, nowIso: string): boolean {
    const nowMilliseconds = Date.parse(nowIso);
    if (Number.isNaN(nowMilliseconds)) {
      return false;
    }
    return nowMilliseconds < Date.parse(claim.expiresAtIso);
  }

  /**
   * 请求续接：返回是否领取成功。不做派发。
   *
   * 判定顺序固定：配置关闭 → 状态不可续（still-running/completed/…）→ 回执无效 → 领取。
   */
  async requestContinuation(input: {
    readonly request: StructuredContinuationRequest | null;
    readonly candidates: readonly ContinuationCandidate[];
    readonly principalIdentifier: string;
    readonly requestIdentifier: string | null;
    readonly nowIso: string;
  }): Promise<ContinuationClaimResult> {
    const evaluation = evaluateContinuationRequest({
      setting: this.options.setting,
      request: input.request,
      candidates: input.candidates,
    });
    if (evaluation.status !== "resumable") {
      return {
        status: evaluation.status,
        reasonCode: evaluation.reasonCode,
        claim: null,
        candidateTaskIdentifiers: evaluation.candidateTaskIdentifiers,
      };
    }
    if (input.request === null || input.requestIdentifier === null) {
      return {
        status: "needs-selection",
        reasonCode: "target-not-specified",
        claim: null,
        candidateTaskIdentifiers: evaluation.candidateTaskIdentifiers,
      };
    }
    const receiptLookup = await this.options.receiptStore.findValid({
      requestIdentifier: input.requestIdentifier,
      principalIdentifier: input.principalIdentifier,
      taskIdentifier: input.request.taskIdentifier,
      expectedRevision: input.request.expectedRevision,
      nowIso: input.nowIso,
    });
    if (receiptLookup.receipt === null) {
      return {
        status: "claim-conflict",
        reasonCode: receiptLookup.reasonCode ?? "receipt-invalid",
        claim: null,
        candidateTaskIdentifiers: evaluation.candidateTaskIdentifiers,
      };
    }

    const document = await this.readClaims();
    const nowMilliseconds = Date.parse(input.nowIso);
    const activeClaims = document.claims.filter((claim) => this.isActive(claim, input.nowIso));
    const existing = activeClaims.find(
      (claim) =>
        claim.projectIdentifier === input.request!.projectIdentifier &&
        claim.taskIdentifier === input.request!.taskIdentifier,
    );
    if (existing !== undefined) {
      if (existing.requestIdentifier === input.requestIdentifier) {
        return {
          status: "already-claimed",
          reasonCode: "claim-already-held",
          claim: existing,
          candidateTaskIdentifiers: evaluation.candidateTaskIdentifiers,
        };
      }
      if (existing.expectedRevision === input.request.expectedRevision) {
        return {
          status: "claim-conflict",
          reasonCode: "claim-conflict-active",
          claim: null,
          candidateTaskIdentifiers: evaluation.candidateTaskIdentifiers,
        };
      }
    }

    const maximumToken = document.claims.reduce(
      (maximum, claim) => Math.max(maximum, claim.fencingToken),
      0,
    );
    const claim: ContinuationClaim = {
      claimIdentifier: `claim:${input.request.projectIdentifier}:${input.request.taskIdentifier}:${String(maximumToken + 1)}`,
      requestIdentifier: input.requestIdentifier,
      projectIdentifier: input.request.projectIdentifier,
      taskIdentifier: input.request.taskIdentifier,
      expectedRevision: input.request.expectedRevision,
      fencingToken: maximumToken + 1,
      claimedAtIso: new Date(nowMilliseconds).toISOString(),
      expiresAtIso: new Date(
        nowMilliseconds + CONTINUATION_CLAIM_LEASE_MILLISECONDS,
      ).toISOString(),
    };
    await this.writeClaims({
      schemaVersion: CONTINUATION_CLAIM_SCHEMA_VERSION,
      revision: document.revision + 1,
      claims: [...activeClaims, claim],
    });
    return {
      status: "claimed",
      reasonCode: "checkpoint-confirmed-not-executed",
      claim,
      candidateTaskIdentifiers: evaluation.candidateTaskIdentifiers,
    };
  }

  /**
   * 提交前的 fencing 复核：token 必须等于该任务**当前**的活动领取，
   * 否则拒绝（旧执行者/过期领取不能提交新状态）。
   */
  async isFencingTokenCurrent(input: {
    readonly claim: ContinuationClaim;
    readonly nowIso: string;
  }): Promise<boolean> {
    const document = await this.readClaims();
    const activeClaims = document.claims.filter((claim) => this.isActive(claim, input.nowIso));
    /** 同一任务可能同时存在旧领取（未过期但已被取代）⇒ 以**最高 token** 为当前。 */
    const current = activeClaims
      .filter(
        (claim) =>
          claim.projectIdentifier === input.claim.projectIdentifier &&
          claim.taskIdentifier === input.claim.taskIdentifier,
      )
      .reduce<ContinuationClaim | null>(
        (maximum, claim) =>
          maximum === null || claim.fencingToken > maximum.fencingToken ? claim : maximum,
        null,
      );
    return current !== null && current.fencingToken === input.claim.fencingToken;
  }

  async listClaims(nowIso: string): Promise<ContinuationClaim[]> {
    return (await this.readClaims()).claims.filter((claim) => this.isActive(claim, nowIso));
  }
}
