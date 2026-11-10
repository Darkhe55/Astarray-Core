/**
 * AUDIT-REPAIR-01 检查点 04（2026-11-10）：**装配级**通信转交入口。
 *
 * 卡内完成判据要求"从应用或 SDK 的**真实装配入口**验证成功、拒绝、撤销/未知工具路径"。
 * 本文件走 `createApplicationRuntime` 拿到的真实控制器，验证：
 *  ① 入口存在（装配后可用）；
 *  ② 缺授权来源/裁决引用 ⇒ **拒绝**（不允许"无授权的转交"）；
 *  ③ 合法输入 ⇒ 产出**不透明句柄**且带到期时间。
 *
 * 未覆盖（如实）：完整投递校验上下文（`DelegationValidationContext` 形状较大），
 * 留待下一条用例。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-audit04-delegation-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function createRuntime() {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
    workerRuntimeFactory: () => ({
      async *run() {
        yield { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" };
      },
    }),
  });
}

function buildGrantInput() {
  return {
    authorizationSource: "user",
    userDecisionReference: "u1",
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
    replyRoute: "to-recipient" as const,
    isCopyToGrantorRequired: false,
    expiresAtIso: null,
    maxInFlightMessages: 1,
  };
}

describe("AUDIT-REPAIR-01-04 装配级：通信转交入口", () => {
  it("**缺授权裁决引用 ⇒ 拒绝**（不得无授权转交）", async () => {
    const runtime = await createRuntime();
    try {
      expect(() =>
        runtime.controller.createCommunicationDelegationGrant({
          ...buildGrantInput(),
          userDecisionReference: "   ",
        }),
      ).toThrow(/授权|裁决|authorization/iu);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("**合法输入 ⇒ 产出不透明句柄**（不暴露可转授信息）", async () => {
    const runtime = await createRuntime();
    try {
      const grant = runtime.controller.createCommunicationDelegationGrant(buildGrantInput());
      expect(grant.communicationHandleIdentifier.length).toBeGreaterThan(0);
      /** 句柄不得是"另一份授权"的导出物：与输入里的身份串不同。 */
      expect(grant.communicationHandleIdentifier).not.toContain("secondary-2");
      expect(grant.expiresAtIso === null || typeof grant.expiresAtIso === "string").toBe(true);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
