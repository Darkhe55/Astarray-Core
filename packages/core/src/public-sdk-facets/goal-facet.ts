/**
 * AXIOMATIC-DESIGN 阶段②（P2，2026-11-26）：**目标模式子门面**。
 *
 * 从 `public-sdk.ts` 切出目标域 12 个方法（激活/提案/确认/绑定/状态/停用/关闭/映射/失效）：
 * 这些方法原本就是"逐字委托 runtime"⇒ 迁出后门面只剩转发，子门面可独立测试。
 *
 * 约束：
 * - 行为与门面原实现逐字一致（含 `assertOpen()` 先判）；
 * - 门面保留同名方法并委托（导出面不变）；
 * - 宿主以**窄接口**注入 `goalService`（结构上与 runtime 目标服务一致）。
 */
import type { GoalContract } from "../orchestration/goal-contract.js";
import type { GoalContractProposalDraft } from "../orchestration/goal-contract-proposal.js";
import type { GoalModeStatusView } from "../orchestration/goal-mode-store.js";

/** R81：目标模式激活输入（与运行时同构；门面不复制判定规则）。 */
export interface GoalModeActivationInput {
  readonly isExplicitUserRequest: boolean;
  readonly isAuthenticatedUser: boolean;
  readonly isExplicitlyEnabled: boolean;
  readonly requestedBy: "user" | "model" | "tertiary-agent";
}

/** 子门面所需的最小宿主能力：一个目标服务 + 关闭态检查。 */
export interface GoalFacetHost {
  assertOpen(): void;
  readonly goalService: {
    activateGoalMode(input: {
      readonly isExplicitUserRequest: boolean;
      readonly isAuthenticatedUser: boolean;
      readonly isExplicitlyEnabled: boolean;
      readonly requestedBy: "user" | "model" | "tertiary-agent";
    }): { readonly isActive: boolean; readonly reason: string };
    getGoalModeActivation(): { readonly isActive: boolean; readonly reason: string };
    proposeGoalContract(input: {
      readonly draft: GoalContractProposalDraft;
      readonly sourceRequestReference: string;
      readonly expiresInSeconds?: number;
    }): Promise<{ readonly proposalIdentifier: string; readonly expiresAtIso: string }>;
    confirmGoalContract(input: {
      readonly proposalIdentifier: string;
      readonly goalIdentifier: string;
      readonly ownerIdentifier: string;
      readonly activation: GoalModeActivationInput;
      readonly isUserConfirmation: boolean;
    }): Promise<{ readonly goalIdentifier: string; readonly revision: number }>;
    createGoalContract(input: {
      readonly contract: GoalContract;
      readonly activation: GoalModeActivationInput;
    }): Promise<{ readonly isActive: boolean; readonly reason: string }>;
    bindMissionToGoal(input: {
      readonly missionIdentifier: string;
      readonly goalIdentifier: string;
    }): Promise<{ readonly goalIdentifier: string }>;
    unbindMissionFromGoal(missionIdentifier: string): Promise<{ readonly didUnbind: boolean }>;
    describeGoalStatus(goalIdentifier: string): Promise<GoalModeStatusView | null>;
    deactivateGoal(input: {
      readonly goalIdentifier: string;
      readonly reason: string;
    }): Promise<{ readonly closedAtIso: string; readonly unboundMissionCount: number }>;
    closeGoalExperiment(input: {
      readonly goalIdentifier: string;
      readonly reason: string;
    }): Promise<{ readonly isExperimentClosed: boolean; readonly closedAtIso: string }>;
    bindRequirementTaskMapping(input: {
      readonly goalIdentifier: string;
      readonly requirementIdentifier: string;
      readonly taskNodeIdentifiers: readonly string[];
    }): Promise<{ readonly mappingCount: number; readonly documentRevision: number }>;
    invalidateGoalEvidence(input: {
      readonly goalIdentifier: string;
      readonly requirementIdentifiers: readonly string[];
      readonly reason: string;
    }): Promise<{
      readonly potentialValueAfterInvalidation: number | null;
      readonly invalidatedRequirementIdentifiers: readonly string[];
    }>;
  };
}

export class GoalFacet {
  constructor(private readonly host: GoalFacetHost) {}

  activateGoalMode(input: {
    readonly isExplicitUserRequest: boolean;
    readonly isAuthenticatedUser: boolean;
    readonly isExplicitlyEnabled: boolean;
    readonly requestedBy: "user" | "model" | "tertiary-agent";
  }): { readonly isActive: boolean; readonly reason: string } {
    this.host.assertOpen();
    return this.host.goalService.activateGoalMode(input);
  }

  getGoalModeActivation(): { readonly isActive: boolean; readonly reason: string } {
    this.host.assertOpen();
    return this.host.goalService.getGoalModeActivation();
  }

  proposeGoalContract(input: {
    readonly draft: GoalContractProposalDraft;
    readonly sourceRequestReference: string;
    readonly expiresInSeconds?: number;
  }): Promise<{ readonly proposalIdentifier: string; readonly expiresAtIso: string }> {
    this.host.assertOpen();
    return this.host.goalService.proposeGoalContract(input);
  }

  confirmGoalContract(input: {
    readonly proposalIdentifier: string;
    readonly goalIdentifier: string;
    readonly ownerIdentifier: string;
    readonly activation: GoalModeActivationInput;
    readonly isUserConfirmation: boolean;
  }): Promise<{ readonly goalIdentifier: string; readonly revision: number }> {
    this.host.assertOpen();
    return this.host.goalService.confirmGoalContract(input);
  }

  createGoalContract(input: {
    readonly contract: GoalContract;
    readonly activation: GoalModeActivationInput;
  }): Promise<{ readonly isActive: boolean; readonly reason: string }> {
    this.host.assertOpen();
    return this.host.goalService.createGoalContract(input);
  }

  bindMissionToGoal(input: {
    readonly missionIdentifier: string;
    readonly goalIdentifier: string;
  }): Promise<{ readonly goalIdentifier: string }> {
    this.host.assertOpen();
    return this.host.goalService.bindMissionToGoal(input);
  }

  unbindMissionFromGoal(missionIdentifier: string): Promise<{ readonly didUnbind: boolean }> {
    this.host.assertOpen();
    return this.host.goalService.unbindMissionFromGoal(missionIdentifier);
  }

  describeGoalStatus(goalIdentifier: string): Promise<GoalModeStatusView | null> {
    this.host.assertOpen();
    return this.host.goalService.describeGoalStatus(goalIdentifier);
  }

  deactivateGoal(input: {
    readonly goalIdentifier: string;
    readonly reason: string;
  }): Promise<{ readonly closedAtIso: string; readonly unboundMissionCount: number }> {
    this.host.assertOpen();
    return this.host.goalService.deactivateGoal(input);
  }

  closeGoalExperiment(input: {
    readonly goalIdentifier: string;
    readonly reason: string;
  }): Promise<{ readonly isExperimentClosed: boolean; readonly closedAtIso: string }> {
    this.host.assertOpen();
    return this.host.goalService.closeGoalExperiment(input);
  }

  bindRequirementTaskMapping(input: {
    readonly goalIdentifier: string;
    readonly requirementIdentifier: string;
    readonly taskNodeIdentifiers: readonly string[];
  }): Promise<{ readonly mappingCount: number; readonly documentRevision: number }> {
    this.host.assertOpen();
    return this.host.goalService.bindRequirementTaskMapping(input);
  }

  invalidateGoalEvidence(input: {
    readonly goalIdentifier: string;
    readonly requirementIdentifiers: readonly string[];
    readonly reason: string;
  }): Promise<{
    readonly potentialValueAfterInvalidation: number | null;
    readonly invalidatedRequirementIdentifiers: readonly string[];
  }> {
    this.host.assertOpen();
    return this.host.goalService.invalidateGoalEvidence(input);
  }
}
