/**
 * AXIOMATIC-DESIGN P2（2026-11-26）：目标域子门面的独立契约。
 *
 * 目标域方法原本是"逐字委托 runtime"；迁出后验证：转发不改变语义、关闭态不触达服务、类型面保持。
 */
import { describe, expect, it, vi } from "vitest";

import { GoalFacet } from "../../../packages/core/src/public-sdk-facets/goal-facet.js";

function buildHost(overrides: Record<string, unknown> = {}) {
  const assertOpen = vi.fn();
  const goalService = {
    activateGoalMode: vi.fn(() => ({ isActive: true, reason: "用户显式请求" })),
    getGoalModeActivation: vi.fn(() => ({ isActive: true, reason: "已激活" })),
    proposeGoalContract: vi.fn(async () => ({
      proposalIdentifier: "proposal-1",
      expiresAtIso: "2026-11-26T01:00:00.000Z",
    })),
    confirmGoalContract: vi.fn(async () => ({ goalIdentifier: "goal-1", revision: 2 })),
    createGoalContract: vi.fn(async () => ({ isActive: true, reason: "用户确认" })),
    bindMissionToGoal: vi.fn(async () => ({ goalIdentifier: "goal-1" })),
    unbindMissionFromGoal: vi.fn(async () => ({ didUnbind: true })),
    describeGoalStatus: vi.fn(async () => ({ goalIdentifier: "goal-1", isPaused: false })),
    deactivateGoal: vi.fn(async () => ({
      closedAtIso: "2026-11-26T02:00:00.000Z",
      unboundMissionCount: 1,
    })),
    closeGoalExperiment: vi.fn(async () => ({
      isExperimentClosed: true,
      closedAtIso: "2026-11-26T03:00:00.000Z",
    })),
    bindRequirementTaskMapping: vi.fn(async () => ({ mappingCount: 2, documentRevision: 5 })),
    invalidateGoalEvidence: vi.fn(async () => ({
      potentialValueAfterInvalidation: null,
      invalidatedRequirementIdentifiers: ["req-1"],
    })),
  };
  return { host: { assertOpen, goalService, ...overrides } as never, assertOpen, goalService };
}

describe("AXIOMATIC P2：目标域子门面", () => {
  it("① 激活/查询为同步委托，且先 assertOpen", () => {
    const { host, assertOpen, goalService } = buildHost();
    const facet = new GoalFacet(host);

    const activation = facet.activateGoalMode({
      isExplicitUserRequest: true,
      isAuthenticatedUser: true,
      isExplicitlyEnabled: true,
      requestedBy: "user",
    });
    expect(activation).toMatchObject({ isActive: true });
    expect(facet.getGoalModeActivation()).toMatchObject({ isActive: true });
    expect(goalService.activateGoalMode).toHaveBeenCalledTimes(1);
    expect(assertOpen).toHaveBeenCalledTimes(2);
  });

  it("② 提案/确认：参数原样透传，返回值不改写", async () => {
    const { host, goalService } = buildHost();
    const facet = new GoalFacet(host);

    const proposal = await facet.proposeGoalContract({
      draft: { objectiveText: "目标" } as never,
      sourceRequestReference: "user-message-1",
    });
    expect(proposal.proposalIdentifier).toBe("proposal-1");
    expect(goalService.proposeGoalContract).toHaveBeenCalledWith({
      draft: { objectiveText: "目标" },
      sourceRequestReference: "user-message-1",
    });

    const confirmed = await facet.confirmGoalContract({
      proposalIdentifier: "proposal-1",
      goalIdentifier: "goal-1",
      ownerIdentifier: "user-1",
      activation: {
        isExplicitUserRequest: true,
        isAuthenticatedUser: true,
        isExplicitlyEnabled: true,
        requestedBy: "user",
      },
      isUserConfirmation: true,
    });
    expect(confirmed).toMatchObject({ goalIdentifier: "goal-1", revision: 2 });
  });

  it("③ 绑定/解绑/状态/停用/关闭：各自委托到对应服务方法", async () => {
    const { host } = buildHost();
    const facet = new GoalFacet(host);

    expect(
      await facet.bindMissionToGoal({ missionIdentifier: "mission-1", goalIdentifier: "goal-1" }),
    ).toMatchObject({ goalIdentifier: "goal-1" });
    expect(await facet.unbindMissionFromGoal("mission-1")).toMatchObject({ didUnbind: true });
    expect(await facet.describeGoalStatus("goal-1")).toMatchObject({ goalIdentifier: "goal-1" });
    expect(
      await facet.deactivateGoal({ goalIdentifier: "goal-1", reason: "用户停用" }),
    ).toMatchObject({ unboundMissionCount: 1 });
    expect(
      await facet.closeGoalExperiment({ goalIdentifier: "goal-1", reason: "结束实验" }),
    ).toMatchObject({ isExperimentClosed: true });
  });

  it("④ 映射/失效：返回值保留 undefined 语义（不伪造数值）", async () => {
    const { host } = buildHost();
    const facet = new GoalFacet(host);
    expect(
      await facet.bindRequirementTaskMapping({
        goalIdentifier: "goal-1",
        requirementIdentifier: "req-1",
        taskNodeIdentifiers: ["T-1", "T-2"],
      }),
    ).toMatchObject({ mappingCount: 2, documentRevision: 5 });
    expect(
      await facet.invalidateGoalEvidence({
        goalIdentifier: "goal-1",
        requirementIdentifiers: ["req-1"],
        reason: "证据失效",
      }),
    ).toMatchObject({ potentialValueAfterInvalidation: null });
  });

  it("⑤ assertOpen 抛错 ⇒ 不触达目标服务（关闭态不越过）", () => {
    const { host, goalService } = buildHost({
      assertOpen: () => {
        throw new Error("application-closed");
      },
    });
    const facet = new GoalFacet(host);
    expect(() => facet.getGoalModeActivation()).toThrow("application-closed");
    expect(goalService.getGoalModeActivation).not.toHaveBeenCalled();
  });
});
