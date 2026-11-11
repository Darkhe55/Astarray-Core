/**
 * COMM-01-02 切片：**投递前复检**（撤销 / 到期 / 在途量 / profile revision）。
 *
 * 卡内要求的是"撤销与到期**在途**复检"：不能只在发送时校验一次，
 * 每次投递都要按当时状态重新判定。此前 `assertDeliverable` **无任何测试引用**。
 */
import { describe, expect, it } from "vitest";

import {
  AgentCommunicationDelegationController,
  DelegatedAgentCommunicationGrantStore,
} from "../../../packages/core/src/orchestration/agent-communication-delegation.js";

function buildController(nowUnixMilliseconds = 1_700_000_000_000) {
  return new AgentCommunicationDelegationController(
    new DelegatedAgentCommunicationGrantStore(),
    () => nowUnixMilliseconds,
  );
}

function createGrant(controller: ReturnType<typeof buildController>, overrides: Record<string, unknown> = {}) {
  return controller.createGrant({
    authorizationSource: "test",
    userDecisionReference: "decision-1",
    grantorSuperiorAgentInstanceId: "secondary-1",
    recipientPeerAgentInstanceId: "secondary-2",
    targetAgentInstanceId: "tertiary-1",
    grantorRole: "secondary",
    recipientRole: "secondary",
    targetRole: "tertiary",
    isTargetAlive: true,
    missionId: "mission-1",
    taskScope: "T-001",
    allowedMessageTypes: ["report"],
    isInstructionAllowed: false,
    replyRoute: "direct",
    isCopyToGrantorRequired: false,
    expiresAtIso: null,
    maxInFlightMessages: 2,
    ...overrides,
  } as never) as never;
}

const aliveContext = {
  isTargetRecycled: false,
  isGrantorStillDirectSuperior: true,
  isMissionEnded: false,
  isRevokedByUser: false,
};

describe("沟通转交：投递前复检", () => {
  it("① 合法状态下可投递", () => {
    const controller = buildController();
    const grant = createGrant(controller) as { communicationHandleIdentifier: string; revision?: number };
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "report",
        missionId: "mission-1",
        currentProfileRevision: grant.revision as number,
        context: aliveContext,
        currentInFlightMessages: 0,
      } as never),
    ).not.toThrow();
  });

  it("② 用户已撤销 ⇒ 投递被拒（不是只在发送时检查）", () => {
    const controller = buildController();
    const grant = createGrant(controller) as { communicationHandleIdentifier: string; revision?: number };
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "report",
        missionId: "mission-1",
        currentProfileRevision: grant.revision as number,
        context: { ...aliveContext, isRevokedByUser: true },
        currentInFlightMessages: 0,
      } as never),
    ).toThrow();
  });

  it("③ 在途量已达上限 ⇒ 投递被拒", () => {
    const controller = buildController();
    const grant = createGrant(controller) as { communicationHandleIdentifier: string; revision?: number };
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "report",
        missionId: "mission-1",
        currentProfileRevision: grant.revision as number,
        context: aliveContext,
        currentInFlightMessages: 2,
      } as never),
    ).toThrow();
  });

  it("④ profile revision 变化 ⇒ 投递被拒", () => {
    const controller = buildController();
    const grant = createGrant(controller) as { communicationHandleIdentifier: string; revision?: number };
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "report",
        missionId: "mission-1",
        currentProfileRevision: (grant.revision as number) + 1,
        context: aliveContext,
        currentInFlightMessages: 0,
      } as never),
    ).toThrow();
  });

  it("⑥ **跨任务（mission 不同）** ⇒ 投递被拒，不得借他人句柄投递", () => {
    const controller = buildController();
    const grant = createGrant(controller) as { communicationHandleIdentifier: string; revision?: number };
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "report",
        missionId: "mission-2",
        currentProfileRevision: grant.revision as number,
        context: aliveContext,
        currentInFlightMessages: 0,
      } as never),
    ).toThrow();
  });
  it("⑤ 已到期 ⇒ 投递被拒", () => {
    const controller = buildController(1_700_000_000_000);
    const grant = createGrant(controller, { expiresAtIso: "2023-11-14T00:00:00.000Z" }) as {
      communicationHandleIdentifier: string;
      revision?: number;
    };
    expect(() =>
      controller.assertDeliverable({
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "report",
        missionId: "mission-1",
        currentProfileRevision: grant.revision as number,
        context: aliveContext,
        currentInFlightMessages: 0,
      } as never),
    ).toThrow();
  });
});
