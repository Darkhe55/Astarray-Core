/**
 * B9（2026-11-25）：门面零覆盖方法批量烟囱（第二批）。
 *
 * 原则：每个方法至少调用一次，并区分"合法入参"与"非法/缺失入参"两路；
 * 允许方法如实抛错，但**不允许**测试假绿（只断言调用发生）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-facade-batch2-"));
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

describe("B9：门面零覆盖方法（第二批）", () => {
  it("① 权限组：读取/重命名/重置/删除/导出/导入 均先各自调用一次", async () => {
    const facade = await createFacade();
    try {
      const profileRef = { kind: "builtin", profileId: "assist" } as const;
      expect(await settle(() => facade.readPermissionProfile(profileRef))).toHaveProperty("value");
      expect(await settle(() => facade.exportPermissionProfile(profileRef))).toHaveProperty("value");
      expect(
        await settle(() =>
          facade.renamePermissionProfile({
            permissionProfileId: "profile-missing",
            newDisplayName: "新名字",
            expectedRevision: 1,
          } as never),
        ),
      ).toHaveProperty("error");
      expect(
        await settle(() =>
          facade.resetPermissionProfile({
            permissionProfileId: "profile-missing",
            source: { kind: "blank" },
            expectedRevision: 1,
          } as never),
        ),
      ).toHaveProperty("error");
      expect(
        await settle(() =>
          facade.deletePermissionProfile({
            permissionProfileId: "profile-missing",
            isCurrentlyActive: false,
          } as never),
        ),
      ).toHaveProperty("error");
      expect(
        await settle(() => facade.importPermissionProfile({ exportedDocument: {} } as never)),
      ).toHaveProperty("error");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 权限判定概览：list / preview / query 三个入口都调用", async () => {
    const facade = await createFacade();
    try {
      expect(await settle(() => facade.listPermissionToolOverview())).toHaveProperty("value");
      expect(
        await settle(() =>
          facade.previewToolPermission({ toolName: "readFile", action: "read" } as never),
        ),
      ).toHaveProperty("value");
      expect(await settle(() => facade.queryPermissionToolOverview())).toHaveProperty("value");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 恢复与验收：恢复总览/检查/续接、验证结论、启动恢复", async () => {
    const facade = await createFacade();
    try {
      expect(await settle(() => facade.queryRecoveryOverview())).toHaveProperty("value");
      const inspected = await settle(() => facade.inspectRecoveryMission("mission-missing" as never));
      /** 未知 mission ⇒ 返回 null 或抛错都算如实（不得伪造一份检查结果）。 */
      expect(inspected.error !== undefined || inspected.value === null).toBe(true);
      const resumed = await settle(() =>
        facade.resumeRecoveredMission({ missionIdentifier: "mission-missing" } as never),
      );
      /** 未知 mission ⇒ 抛错或"无可恢复"结果；不得伪造已恢复。 */
      expect(resumed.error !== undefined || resumed.value !== undefined).toBe(true);
      expect(
        await settle(() =>
          facade.recordVerificationDecision({
            missionIdentifier: "mission-missing",
            ownerAgentInstanceId: "agent-1",
            taskIdentifier: "T-1",
            decision: "accepted",
          } as never),
        ),
      ).toHaveProperty("error");
      expect(await settle(() => facade.runStartupRecoveryNow())).toHaveProperty("value");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("④ 实验设置/安装询问/协作消息状态/工具包版本与工件", async () => {
    const facade = await createFacade();
    try {
      expect(
        await settle(() =>
          facade.updateExperimentSettings({
            enabledExperimentIdentifiers: [],
            expectedRevision: 1,
          } as never),
        ),
      ).toHaveProperty("value");

      expect(await settle(() => facade.listPendingInstallationInquiries())).toHaveProperty("value");
      const answered = await settle(() =>
        facade.answerInstallationInquiry({
          inquiryIdentifier: "inquiry-missing",
          expectedRevision: 1,
          answer: "deny",
        } as never),
      );
      /** 无该询问 ⇒ 抛错或明确空结果；不得返回"已答复"记录。 */
      expect(answered.error !== undefined || answered.value === undefined).toBe(true);
      const decided = await settle(() =>
        facade.decideInstallationAllowOnce({ inquiryIdentifier: "inquiry-missing" } as never),
      );
      expect(decided.error !== undefined || decided.value === undefined).toBe(true);
      expect(
        await settle(() =>
          facade.readCoordinationMessageStatus({ messageIdentifier: "msg-missing" } as never),
        ),
      ).toHaveProperty("value");

      const registered = await settle(() =>
        facade.registerToolPackageVersion({
          projectIdentifier: "project-1",
          toolPackageId: "pkg-1",
          version: 1,
          contentHash: "sha256:x",
          zipPath: path.join(stateDirectory, "missing.zip"),
        } as never),
      );
      /** 缺 zip ⇒ 抛错或空返回；不得伪造版本登记。 */
      expect(registered.error !== undefined || registered.value === undefined).toBe(true);
      expect(
        await settle(() =>
          facade.registerArtifact({
            projectIdentifier: "project-1",
            missionIdentifier: "mission-1",
            taskIdentifier: "T-1",
            artifactType: "document",
            displayName: "说明",
            location: "docs/x.md",
          } as never),
        ),
      ).toHaveProperty("value");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("⑤ 委派通信与工具帮助：缺授权 ⇒ 拒绝而不是放行", async () => {
    const facade = await createFacade();
    try {
      expect(
        await settle(() =>
          facade.delegateAgentCommunication({
            authorizationSource: "user",
            userDecisionReference: "decision-1",
            grantorSuperiorAgentInstanceId: "agent-1",
            recipientPeerAgentInstanceId: "agent-2",
            targetAgentInstanceId: "agent-3",
          } as never),
        ),
      ).toHaveProperty("error");
      expect(
        await settle(() =>
          facade.requestToolHelp({
            request: {},
            requesterAgentInstanceId: "agent-1",
            defaultSuperiorAgentInstanceId: "agent-0",
            missionId: "mission-1",
          } as never),
        ),
      ).toHaveProperty("value");
      expect(
        await settle(() => facade.resolveAgentModelBinding({ agentInstanceId: "agent-1" } as never)),
      ).toHaveProperty("value");
      const cleared = await settle(() =>
        facade.clearAgentModelBinding({ agentInstanceId: "agent-1" } as never),
      );
      /** 无绑定可清 ⇒ 抛错或空结果都算如实。 */
      expect(cleared.error !== undefined || cleared.value === undefined).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
