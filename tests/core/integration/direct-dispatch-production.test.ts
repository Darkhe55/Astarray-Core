/**
 * ALIGN-01-04（2026-11-08）：**直投产品入口**（用户显式路由到具体次级）。
 *
 * 反例优先：来源必须是认证用户、目标次级必须存在、不得跨项目。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { DirectDispatchController } from "../../../packages/core/src/orchestration/direct-dispatch-controller.js";
import { SmallTaskEligibilityPolicy } from "../../../packages/core/src/orchestration/small-task-eligibility-policy.js";
import { TaskSequenceManageController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";

let stateDirectory: string;
let runtime: Awaited<ReturnType<typeof createApplicationRuntime>> | null = null;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-direct-dispatch-"));
});

afterEach(async () => {
  if (runtime !== null) await runtime.shutdown().catch(() => undefined);
  runtime = null;
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function createRuntime() {
  runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 4,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  });
  return runtime;
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    envelopeId: "envelope-1",
    authenticatedUserId: "user-1",
    targetSecondaryAgentInstanceId: "secondary-agent-1",
    scopeDescription: "修改一个局部的说明文字",
    originalUserInstruction: "把 README 里的标题改成 Astarray",
    priorityTier: 0 as const,
    anchor: { predecessorTaskIds: [], successorTaskIds: [] },
    acceptanceCriteria: "README 标题为 Astarray",
    attachedContextReferenceHashes: [`sha256:${"1".repeat(64)}`],
    createdAtIso: "2026-11-08T10:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

const eligibleCharacteristics = {
  requiresDesignDiscussion: false,
  modifiesArchitectureOrPublicContract: false,
  hasUnresolvedHighRiskRuling: false,
  requiresCrossProjectCoordination: false,
};

describe("直投产品入口（ALIGN-01-04）", () => {
  it("认证用户 + 已登记次级 + 序列已发布 ⇒ dispatched", async () => {
    const application = await createRuntime();
    /** 先让目标次级在注册表里存在（直投要求具体个体存在）。 */
    application.controller.registerAgent({
      agentInstanceId: "secondary-agent-1",
      agentRole: "secondary",
      missionId: "mission-cli",
      owningSecondaryAgentInstanceId: null,
      boundTaskBundleId: "bundle-cli",
    });
    /** 目标序列必须先存在（ALIGN-02-01 的生产入口）。 */
    const statusController = application.taskSequenceStatusController;
    await application.taskSequenceManageController.publishOrInsertTask({
      ownerAgentInstanceId: "secondary-agent-1",
      actor: { sourceKind: "user", actorId: "user-1" },
      sequenceId: "sequence-secondary-agent-1",
      task: {
        taskId: "seed-task-1",
        title: "占位任务（建立序列）",
        priorityTier: 0,
        externalReference: null,
      },
      anchor: { predecessorTaskIds: [], successorTaskIds: [] },
    });
    const snapshot = await statusController.getSnapshot({
      ownerAgentInstanceId: "secondary-agent-1",
      sequenceId: "sequence-secondary-agent-1",
      viewer: { sourceKind: "user", actorId: "user-1" },
    });

    const result = await application.controller
      .getT08cRoutingFacade()!
      .directDispatchController.dispatchDirectTask({
        /** 序列表要求插入必须有锚点；直投到既有任务的**后继**。 */
        envelope: envelope({
          anchor: { predecessorTaskIds: ["seed-task-1"], successorTaskIds: [] },
        }),
        userRouteDecision: { kind: "follow-policy-suggestion" },
        expectedSequenceRevision: snapshot.revision,
        eligibilityCharacteristics: eligibleCharacteristics,
      });
    expect(result.outcome).toBe("dispatched");

    const after = await statusController.getSnapshot({
      ownerAgentInstanceId: "secondary-agent-1",
      sequenceId: "sequence-secondary-agent-1",
      viewer: { sourceKind: "user", actorId: "user-1" },
    });
    expect(after.nodes.some((node) => node.taskId === "envelope-1")).toBe(true);
    const dispatchedNode = after.nodes.find((node) => node.taskId === "envelope-1");
    expect(dispatchedNode?.priorityTier).toBe(0);
    expect(dispatchedNode?.sourceKind).toBe("user");
  });

  it("来源与认证用户不一致 ⇒ 拒绝（模型不能伪造用户来源）", async () => {
    const application = await createRuntime();
    application.controller.registerAgent({
      agentInstanceId: "secondary-agent-1",
      agentRole: "secondary",
      missionId: "mission-cli",
      owningSecondaryAgentInstanceId: null,
      boundTaskBundleId: "bundle-cli",
    });
    await expect(
      application.controller
        .getT08cRoutingFacade()!
        .directDispatchController.dispatchDirectTask({
          envelope: envelope({ authenticatedUserId: "model-forged-user" }),
          userRouteDecision: { kind: "force-dispatch", confirmationText: "我确认" },
          expectedSequenceRevision: 1,
          eligibilityCharacteristics: eligibleCharacteristics,
        }),
    ).rejects.toThrow(/直投来源与认证用户不一致/u);
  });

  it("目标次级不存在 ⇒ 拒绝（不得按昵称猜收件人）", async () => {
    const application = await createRuntime();
    await expect(
      application.controller
        .getT08cRoutingFacade()!
        .directDispatchController.dispatchDirectTask({
          envelope: envelope({ targetSecondaryAgentInstanceId: "secondary-unknown" }),
          userRouteDecision: { kind: "force-dispatch", confirmationText: "我确认" },
          expectedSequenceRevision: 1,
          eligibilityCharacteristics: eligibleCharacteristics,
        }),
    ).rejects.toThrow(/目标次级 Agent 不存在/u);
  });

  it("不符合直投资格且用户未显式强制 ⇒ 无损回到主 Agent", async () => {
    const application = await createRuntime();
    application.controller.registerAgent({
      agentInstanceId: "secondary-agent-1",
      agentRole: "secondary",
      missionId: "mission-cli",
      owningSecondaryAgentInstanceId: null,
      boundTaskBundleId: "bundle-cli",
    });
    const result = await application.controller
      .getT08cRoutingFacade()!
      .directDispatchController.dispatchDirectTask({
        envelope: envelope({ scopeDescription: "重构整个调度架构与公共契约" }),
        userRouteDecision: { kind: "follow-policy-suggestion" },
        expectedSequenceRevision: 1,
        eligibilityCharacteristics: {
          ...eligibleCharacteristics,
          requiresDesignDiscussion: true,
          modifiesArchitectureOrPublicContract: true,
        },
      });
    expect(result.outcome).toBe("returned-to-main-agent");
  });

  it("控制器独立构造：跨项目/未知序列不写序列（如实失败）", async () => {
    const application = await createRuntime();
    const controller = new DirectDispatchController({
      authenticatedUserId: "user-1",
      eligibilityPolicy: new SmallTaskEligibilityPolicy(),
      sequenceManageController: new TaskSequenceManageController(
        application.taskSequenceManageController["store"] ?? ({} as never),
        { nowUnixMilliseconds: () => Date.now() } as never,
      ) as TaskSequenceManageController,
      doesSecondaryAgentExist: () => true,
    });
    /** 序列不存在 ⇒ 投递应抛错，不得静默创建序列。 */
    await expect(
      controller.dispatchDirectTask({
        envelope: envelope({ targetSecondaryAgentInstanceId: "secondary-agent-1" }),
        userRouteDecision: { kind: "force-dispatch", confirmationText: "我确认" },
        expectedSequenceRevision: 1,
        eligibilityCharacteristics: eligibleCharacteristics,
      }),
    ).rejects.toThrow();
  });
});
