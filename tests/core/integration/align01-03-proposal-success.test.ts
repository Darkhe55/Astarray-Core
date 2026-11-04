/**
 * ALIGN-01-03（2026-11-04）：主 Agent 提案**成功提交**到派生次级的序列。
 *
 * 规则组合（缺一不可）：
 * 1) 契约禁止主 Agent 投给自己 ⇒ 目标必须是次级；
 * 2) 序列层只允许"用户或所有者本人"管理 ⇒ 主 Agent 需要**派生关系**；
 * 3) 派生关系由宿主登记（createdByAgentInstanceId），模型无法声明。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { ConversationTaskInsertionController } from "../../../packages/core/src/orchestration/conversation-task-insertion-controller.js";
import { MainAgentTaskProposalContract } from "../../../packages/core/src/orchestration/main-agent-proposal-contract.js";

let stateDirectory: string;

function createInsertionController(
  runtime: Awaited<ReturnType<typeof createApplicationRuntime>>,
): ConversationTaskInsertionController {
  return new ConversationTaskInsertionController({
    manageController: runtime.taskSequenceManageController,
    authenticatedUserId: "user-1",
  });
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-align0103-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("ALIGN-01-03 主 Agent 提案成功提交", () => {
  it("对派生次级的序列：契约接受，序列按锚点插入", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      streamOutput: () => {},
    });
    try {
      const mainAgentInstanceId = runtime.mainAgentInstanceId;
      const secondaryAgentInstanceId = "secondary-derived-1";
      runtime.registerAgentIdentity({
        agentInstanceId: secondaryAgentInstanceId,
        agentRole: "secondary",
        missionId: null,
        owningSecondaryAgentInstanceId: null,
        createdByAgentInstanceId: mainAgentInstanceId,
      });

      await runtime.taskSequenceManageController.publishSequence({
        ownerAgentInstanceId: secondaryAgentInstanceId,
        actor: { sourceKind: "user", actorId: "user-1" },
        sequenceId: "sequence-derived-1",
        firstTask: {
          taskId: "task-first",
          title: "首任务",
          priorityTier: 0,
          externalReference: null,
        },
      });

      const contract = new MainAgentTaskProposalContract();
      const result = await contract.submit(
        {
          targetSecondaryAgentInstanceIdentifier: secondaryAgentInstanceId,
          sequenceIdentifier: "sequence-derived-1",
          expectedRevision: 2,
          title: "派生任务",
          acceptanceCriteria: "完成并给出证据",
          predecessorTaskIdentifiers: ["task-first"],
          successorTaskIdentifiers: [],
          userTaskReference: "user-ref-1",
          priorityTier: 1,
          requiredArtifactIdentifiers: [],
        },
        {
          sourceActorIdentifier: mainAgentInstanceId,
          authenticatedUserId: "user-1",
          originalUserTaskReference: "user-ref-1",
          conversationIdentifier: null,
        },
        createInsertionController(runtime),
      );

      expect(result.targetSecondaryAgentInstanceIdentifier).toBe(
        secondaryAgentInstanceId,
      );
      expect(result.sequenceIdentifier).toBe("sequence-derived-1");

      const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
      const document = await store.readSequence(
        secondaryAgentInstanceId,
        "sequence-derived-1",
      );
      expect(document).not.toBeNull();
      expect(document?.nodes.map((node) => node.taskId)).toEqual([
        "task-first",
        `task-${result.proposalIdentifier}`,
      ]);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("非创建者的主 Agent 仍被拒绝（派生关系不可冒充）", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      streamOutput: () => {},
    });
    try {
      const secondaryAgentInstanceId = "secondary-foreign-1";
      runtime.registerAgentIdentity({
        agentInstanceId: secondaryAgentInstanceId,
        agentRole: "secondary",
        missionId: null,
        owningSecondaryAgentInstanceId: null,
        createdByAgentInstanceId: "another-main-agent",
      });
      await runtime.taskSequenceManageController.publishSequence({
        ownerAgentInstanceId: secondaryAgentInstanceId,
        actor: { sourceKind: "user", actorId: "user-1" },
        sequenceId: "sequence-foreign-1",
        firstTask: {
          taskId: "task-first",
          title: "首任务",
          priorityTier: 0,
          externalReference: null,
        },
      });
      const contract = new MainAgentTaskProposalContract();
      await expect(
        contract.submit(
          {
            targetSecondaryAgentInstanceIdentifier: secondaryAgentInstanceId,
            sequenceIdentifier: "sequence-foreign-1",
            expectedRevision: 2,
            title: "越权任务",
            acceptanceCriteria: "不应发生",
            predecessorTaskIdentifiers: ["task-first"],
            successorTaskIdentifiers: [],
            userTaskReference: "user-ref-2",
            priorityTier: 1,
            requiredArtifactIdentifiers: [],
          },
          {
            sourceActorIdentifier: runtime.mainAgentInstanceId,
            authenticatedUserId: "user-1",
            originalUserTaskReference: "user-ref-2",
            conversationIdentifier: null,
          },
          createInsertionController(runtime),
        ),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
