/**
 * ALIGN-01-03（2026-11-04）：派生关系的**持久化**。
 *
 * 运行时只在内存里记 owner→creator 时，重启后主 Agent 就失去对派生次级序列的管理权。
 * 这里验证：登记 → 落盘 → 重启 → 仍可提交。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { AgentCreationRegistry } from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";
import { ConversationTaskInsertionController } from "../../../packages/core/src/orchestration/conversation-task-insertion-controller.js";
import { MainAgentTaskProposalContract } from "../../../packages/core/src/orchestration/main-agent-proposal-contract.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

function runtimeOptions(stateDirectory: string) {
  return {
    mode: "assist" as const,
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    runtimeKind: "mock" as const,
    useFeedbackProcess: false,
    mainAgentInstanceId: "main-agent-1",
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  };
}

const proposalPayload = {
  targetSecondaryAgentInstanceIdentifier: "secondary-persisted",
  sequenceIdentifier: "sequence-persisted",
  expectedRevision: 2,
  title: "重启后仍可提交",
  acceptanceCriteria: "完成",
  predecessorTaskIdentifiers: ["task-first"],
  successorTaskIdentifiers: [],
  userTaskReference: "user-ref-persisted",
  priorityTier: 1,
  requiredArtifactIdentifiers: [],
};

describe("ALIGN-01-03 派生关系持久化", () => {
  it("重启后创建者仍能管理派生次级的序列", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-derivation-"));
    directories.push(stateDirectory);

    const first = await createApplicationRuntime(runtimeOptions(stateDirectory));
    try {
      first.registerAgentIdentity({
        agentInstanceId: "secondary-persisted",
        agentRole: "secondary",
        missionId: null,
        owningSecondaryAgentInstanceId: null,
        createdByAgentInstanceId: "main-agent-1",
      });
      await first.taskSequenceManageController.publishSequence({
        ownerAgentInstanceId: "secondary-persisted",
        actor: { sourceKind: "user", actorId: "user-1" },
        sequenceId: "sequence-persisted",
        firstTask: {
          taskId: "task-first",
          title: "首任务",
          priorityTier: 0,
          externalReference: null,
        },
      });
      /** 落盘是异步的：等 registry 读到记录再重启。 */
      const registry = new AgentCreationRegistry({ stateDirectory });
      const deadline = Date.now() + 10_000;
      let record = await registry.getRecord("secondary-persisted");
      while (record?.createdByAgentInstanceId !== "main-agent-1" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        record = await registry.getRecord("secondary-persisted");
      }
      expect(record?.createdByAgentInstanceId).toBe("main-agent-1");
    } finally {
      await first.shutdown().catch(() => undefined);
    }

    const second = await createApplicationRuntime(runtimeOptions(stateDirectory));
    try {
      const insertion = new ConversationTaskInsertionController({
        manageController: second.taskSequenceManageController,
        authenticatedUserId: "user-1",
      });
      const contract = new MainAgentTaskProposalContract();
      const result = await contract.submit(
        proposalPayload,
        {
          sourceActorIdentifier: "main-agent-1",
          authenticatedUserId: "user-1",
          originalUserTaskReference: "user-ref-persisted",
          conversationIdentifier: null,
        },
        insertion,
      );
      expect(result.sequenceIdentifier).toBe("sequence-persisted");

      const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
      const document = await store.readSequence(
        "secondary-persisted",
        "sequence-persisted",
      );
      expect(document?.nodes.map((node) => node.taskId)).toEqual([
        "task-first",
        expect.stringMatching(/^task-/),
      ]);
    } finally {
      await second.shutdown().catch(() => undefined);
    }
  });
});
