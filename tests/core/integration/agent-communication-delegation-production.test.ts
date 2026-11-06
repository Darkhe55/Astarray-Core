/**
 * AUDIT-REPAIR-01 检查点 04（2026-11-06）：受权通信转交的生产入口与失效检查。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import type { DelegationValidationContext } from "../../../packages/core/src/orchestration/agent-communication-delegation.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

async function createHarness() {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-delegation-"));
  directories.push(stateDirectory);
  return createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  });
}

function validGrantInput() {
  return {
    authorizationSource: "permission-ask:ask-1",
    userDecisionReference: "decision-1",
    grantorSuperiorAgentInstanceId: "secondary-1",
    recipientPeerAgentInstanceId: "secondary-2",
    targetAgentInstanceId: "tertiary-1",
    grantorRole: "secondary" as const,
    recipientRole: "secondary" as const,
    targetRole: "tertiary" as const,
    isTargetAlive: true,
    missionId: "mission-1",
    taskScope: null,
    allowedMessageTypes: ["information" as const],
    isInstructionAllowed: false,
    replyRoute: "to-grantor" as const,
    isCopyToGrantorRequired: true,
    expiresAtIso: null,
    maxInFlightMessages: 2,
  };
}

function validContext(
  overrides: Partial<DelegationValidationContext> = {},
): DelegationValidationContext {
  return {
    profileRevision: 1,
    isTargetRecycled: false,
    isGrantorStillDirectSuperior: true,
    isMissionEnded: false,
    isRevokedByUser: false,
    ...overrides,
  };
}

describe("通信转交生产入口", () => {
  it("合法授权创建不透明句柄；投递复检通过", async () => {
    const runtime = await createHarness();
    try {
      const grant = runtime.controller.createCommunicationDelegationGrant(validGrantInput());
      expect(grant.communicationHandleIdentifier).toMatch(/^handle-/);
      expect(grant).not.toHaveProperty("credential");
      expect(() =>
        runtime.controller.assertCommunicationDelegationDeliverable({
          communicationHandleIdentifier: grant.communicationHandleIdentifier,
          senderAgentInstanceId: "secondary-2",
          messageType: "information",
          missionId: "mission-1",
          currentProfileRevision: 1,
          context: validContext(),
          currentInFlightMessages: 0,
        }),
      ).not.toThrow();
      expect(() =>
        runtime.controller.assertCommunicationDelegationNotReDelegable(
          grant.communicationHandleIdentifier,
        ),
      ).not.toThrow();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("层级/存活/用户裁决缺失 ⇒ 拒绝", async () => {
    const runtime = await createHarness();
    try {
      expect(() =>
        runtime.controller.createCommunicationDelegationGrant({
          ...validGrantInput(),
          targetRole: "secondary",
        }),
      ).toThrow(/低一级/u);
      expect(() =>
        runtime.controller.createCommunicationDelegationGrant({
          ...validGrantInput(),
          recipientRole: "tertiary",
        }),
      ).toThrow(/同级/u);
      expect(() =>
        runtime.controller.createCommunicationDelegationGrant({
          ...validGrantInput(),
          isTargetAlive: false,
        }),
      ).toThrow(/不存活/u);
      expect(() =>
        runtime.controller.createCommunicationDelegationGrant({
          ...validGrantInput(),
          userDecisionReference: " ",
        }),
      ).toThrow(/用户裁决/u);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("撤销/回收/父子变化/mission 结束/revision/到期/类型/在途量 ⇒ 投递拒绝", async () => {
    const runtime = await createHarness();
    try {
      const grant = runtime.controller.createCommunicationDelegationGrant(validGrantInput());
      const base = {
        communicationHandleIdentifier: grant.communicationHandleIdentifier,
        senderAgentInstanceId: "secondary-2",
        messageType: "information" as const,
        missionId: "mission-1",
        currentProfileRevision: 1,
        currentInFlightMessages: 0,
      };
      const cases: Array<[Partial<DelegationValidationContext>, string]> = [
        [{ isRevokedByUser: true }, "撤销"],
        [{ isTargetRecycled: true }, "回收"],
        [{ isGrantorStillDirectSuperior: false }, "父子"],
        [{ isMissionEnded: true }, "结束"],
      ];
      for (const [context, pattern] of cases) {
        expect(() =>
          runtime.controller.assertCommunicationDelegationDeliverable({
            ...base,
            context: validContext(context),
          }),
        ).toThrow(new RegExp(pattern, "u"));
      }
      expect(() =>
        runtime.controller.assertCommunicationDelegationDeliverable({
          ...base,
          currentProfileRevision: 2,
          context: validContext(),
        }),
      ).toThrow(/revision/u);
      expect(() =>
        runtime.controller.assertCommunicationDelegationDeliverable({
          ...base,
          messageType: "instruction",
          context: validContext(),
        }),
      ).toThrow(/消息类型/u);
      expect(() =>
        runtime.controller.assertCommunicationDelegationDeliverable({
          ...base,
          currentInFlightMessages: 2,
          context: validContext(),
        }),
      ).toThrow(/在途/u);
      expect(() =>
        runtime.controller.assertCommunicationDelegationDeliverable({
          ...base,
          senderAgentInstanceId: "secondary-9",
          context: validContext(),
        }),
      ).toThrow(/recipient/u);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("未知句柄不可转授；过期授权拒绝", async () => {
    const runtime = await createHarness();
    try {
      expect(() =>
        runtime.controller.assertCommunicationDelegationNotReDelegable("handle-missing"),
      ).toThrow(/不存在/u);

      const expired = runtime.controller.createCommunicationDelegationGrant({
        ...validGrantInput(),
        expiresAtIso: "2020-01-01T00:00:00.000Z",
      });
      expect(() =>
        runtime.controller.assertCommunicationDelegationDeliverable({
          communicationHandleIdentifier: expired.communicationHandleIdentifier,
          senderAgentInstanceId: "secondary-2",
          messageType: "information",
          missionId: "mission-1",
          currentProfileRevision: 1,
          context: validContext(),
          currentInFlightMessages: 0,
        }),
      ).toThrow(/到期/u);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
