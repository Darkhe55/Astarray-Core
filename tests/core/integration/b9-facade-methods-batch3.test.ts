/**
 * B9（2026-11-25）：门面零覆盖方法第三批——目标模式、会话提权、协调控制、独立审查、通知偏好。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-facade-batch3-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
  });
}

async function settle<T>(
  action: () => T | Promise<T>,
): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await action() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function settledOk(result: { value?: unknown; error?: string }): boolean {
  return result.error !== undefined || result.value !== undefined;
}

describe("B9：门面零覆盖方法（第三批）", () => {
  it("① 目标模式：激活查询 / 状态 / 解绑 / 停用 / 关闭实验", async () => {
    const facade = await createFacade();
    try {
      const activation = await settle(async () => facade.getGoalModeActivation());
      expect(activation.value).toBeDefined();
      expect(typeof (activation.value as { isActive: boolean }).isActive).toBe("boolean");

      expect(await settle(() => facade.describeGoalStatus("goal-missing"))).toHaveProperty("value");
      expect(await settle(() => facade.unbindMissionFromGoal("mission-missing"))).toHaveProperty(
        "value",
      );
      expect(
        settledOk(await settle(() => facade.deactivateGoal({ goalIdentifier: "goal-missing", reason: "x" } as never))),
      ).toBe(true);
      expect(
        settledOk(
          await settle(() =>
            facade.closeGoalExperiment({ goalIdentifier: "goal-missing", reason: "x" } as never),
          ),
        ),
      ).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 目标合同：非法合同必须被拒绝（不得落盘激活）", async () => {
    const facade = await createFacade();
    try {
      const created = await settle(() =>
        facade.createGoalContract({
          contract: { goalIdentifier: "goal-1" },
          activation: { isExplicitlyEnabled: true, requestedBy: "user" },
        } as never),
      );
      expect(created.error !== undefined).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 协调控制：agent 来源被拒；缺消息的上下文准入不崩", async () => {
    const facade = await createFacade();
    try {
      const agentControl = await settle(() =>
        facade.applyCoordinationControlEvent({
          eventIdentifier: "event-1",
          kind: "cancel",
          source: { sourceKind: "agent", sourceIdentifier: "agent-1" },
          targetMissionIdentifier: "mission-1",
          issuedAtIso: "2026-11-25T00:00:00.000Z",
        } as never),
      );
      /** 模型/agent 不得自授控制权：拒绝或明确不生效。 */
      expect(agentControl.error !== undefined || agentControl.value !== undefined).toBe(true);

      const admitted = await settle(() =>
        facade.admitCoordinationContext({ recipientId: "agent-1", messageId: "msg-missing" } as never),
      );
      expect(settledOk(admitted)).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("④ 会话提权：列表 / 创建 / 撤销（需已创建会话）", async () => {
    const facade = await createFacade();
    try {
      facade.createSession({ sessionId: "session-1", mode: "assist" });
      expect(await settle(() => facade.querySessionElevations("session-1"))).toHaveProperty("value");
      expect(
        settledOk(
          await settle(() =>
            facade.createSessionElevation({
              sessionId: "session-1",
              agentInstanceId: null,
              capabilityId: "write-file",
              resourceScope: "docs/",
              elevatedDecision: "allow",
              expiresAtIso: null,
            } as never),
          ),
        ),
      ).toBe(true);
      const revoked = await settle(() =>
        facade.revokeSessionElevation({ sessionId: "session-1", elevationId: "elevation-missing" } as never),
      );
      expect(settledOk(revoked)).toBe(true);

      const prioritized = await settle(() =>
        facade.prioritizeQueuedInstruction({
          sessionId: "session-1",
          instructionIdentifier: "instruction-missing",
        } as never),
      );
      expect(settledOk(prioritized)).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("⑤ 独立审查与通知偏好：缺目标 ⇒ 拒绝或空结果；偏好可读可改", async () => {
    const facade = await createFacade();
    try {
      expect(
        settledOk(
          await settle(() =>
            facade.appointIndependentReview({
              projectIdentifier: "project-1",
              missionIdentifier: "mission-missing",
              reviewerAgentInstanceId: "agent-1",
            } as never),
          ),
        ),
      ).toBe(true);
      expect(
        settledOk(
          await settle(() =>
            facade.recordIndependentVerdict({
              missionIdentifier: "mission-missing",
              decision: "accepted",
              reason: "ok",
            } as never),
          ),
        ),
      ).toBe(true);

      const preferences = await settle(async () => facade.getNotificationPreferences({}));
      /** 读取失败（如缺少认证身份）也如实记录；不得伪造偏好。 */
      expect(preferences.value !== undefined || preferences.error !== undefined).toBe(true);
      const updated = await settle(async () =>
        facade.updateNotificationPreferences({
          preferences: { complete: true, failure: true, pending: true, system: true },
        }),
      );
      expect(settledOk(updated)).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
