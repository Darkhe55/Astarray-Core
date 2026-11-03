/**
 * ALIGN-01-03（2026-11-03）：主 Agent 提案提交的**契约级端到端**。
 *
 * 覆盖：harness 注入来源/用户引用、目标不能是自身、用户引用必须一致、
 * 模型自带 sourceKind/sourceActor 字段被忽略。
 */
import { describe, expect, it } from "vitest";

import { MainAgentTaskProposalContract } from "../../packages/core/src/orchestration/main-agent-proposal-contract.js";

interface CapturedProposal {
  proposalId: string;
  targetSecondaryAgentInstanceId: string;
  sequenceId: string;
  expectedRevision: number;
  sourceKind: string;
  sourceActorId: string;
  task: { taskId: string; title: string; externalReference: string };
}

function createContract(captured: CapturedProposal[]) {
  const contract = new MainAgentTaskProposalContract({
    nowIso: () => "2026-11-03T00:00:00.000Z",
    generateProposalIdentifier: () => "proposal-test-1",
  });
  const insertionController = {
    submitProposal: async (proposal: CapturedProposal) => {
      captured.push(proposal);
    },
  };
  return { contract, insertionController };
}

const payload = {
  targetSecondaryAgentInstanceIdentifier: "scheduler:mission-1",
  sequenceIdentifier: "sequence-1",
  expectedRevision: 0,
  title: "补文档",
  userTaskReference: "user-message-1",
  predecessorTaskIdentifiers: [],
  successorTaskIdentifiers: [],
  priorityTier: 1,
  requiredArtifactIdentifiers: [],
  acceptanceCriteria: "完成",
};

const context = {
  sourceActorIdentifier: "main-agent-1",
  authenticatedUserId: "user-1",
  originalUserTaskReference: "user-message-1",
  conversationIdentifier: "conversation-1",
};

describe("主 Agent 提案提交", () => {
  it("提交成功时来源/用户引用由 harness 注入", async () => {
    const captured: CapturedProposal[] = [];
    const { contract, insertionController } = createContract(captured);
    const result = await contract.submit(
      payload,
      context,
      insertionController as never,
    );
    expect(result.proposalIdentifier).toBe("proposal-test-1");
    expect(result.targetSecondaryAgentInstanceIdentifier).toBe(
      "scheduler:mission-1",
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      targetSecondaryAgentInstanceId: "scheduler:mission-1",
      sequenceId: "sequence-1",
      expectedRevision: 0,
      sourceKind: "agent",
      sourceActorId: "main-agent-1",
    });
    expect(captured[0]!.task.externalReference).toBe("user-task:user-message-1");
  });

  it("模型自报来源字段 ⇒ 直接拒绝", async () => {
    const captured: CapturedProposal[] = [];
    const { contract, insertionController } = createContract(captured);
    await expect(
      contract.submit(
        { ...payload, sourceKind: "user", sourceActorId: "evil" },
        context,
        insertionController as never,
      ),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(captured).toHaveLength(0);
  });

  it("目标指向自身 ⇒ 拒绝", async () => {
    const captured: CapturedProposal[] = [];
    const { contract, insertionController } = createContract(captured);
    await expect(
      contract.submit(
        { ...payload, targetSecondaryAgentInstanceIdentifier: "main-agent-1" },
        context,
        insertionController as never,
      ),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(captured).toHaveLength(0);
  });

  it("用户引用不一致 ⇒ 拒绝（不得凭空发明用户来源）", async () => {
    const captured: CapturedProposal[] = [];
    const { contract, insertionController } = createContract(captured);
    await expect(
      contract.submit(
        { ...payload, userTaskReference: "another-message" },
        context,
        insertionController as never,
      ),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(captured).toHaveLength(0);
  });

  it("缺少用户原始任务 / 来源个体为空 ⇒ 拒绝", async () => {
    const captured: CapturedProposal[] = [];
    const { contract, insertionController } = createContract(captured);
    await expect(
      contract.submit(
        payload,
        { ...context, originalUserTaskReference: "" },
        insertionController as never,
      ),
    ).rejects.toBeDefined();
    await expect(
      contract.submit(
        payload,
        { ...context, sourceActorIdentifier: "" },
        insertionController as never,
      ),
    ).rejects.toBeDefined();
  });
});
