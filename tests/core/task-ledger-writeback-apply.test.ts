/**
 * R120（2026-11-01）：写回提案应用的判定单测。
 *
 * 只应用 mark-sequence-done；需人工批准；revision 必须与提案及当前快照一致；
 * 其它动作原样跳过并给出原因。
 */
import { describe, expect, it } from "vitest";

import { TaskLedgerBridge } from "../../packages/core/src/orchestration/task-ledger-bridge.js";
import type { ActorIdentity } from "../../packages/core/src/orchestration/task-sequence-controllers.js";

const viewer: ActorIdentity = { sourceKind: "user", actorId: "user-local" };

function buildBridge(input: {
  readonly sequenceRevision?: number;
  readonly isTransitionWired?: boolean;
  readonly onTransition?: (taskId: string, revision: number) => void;
} = {}) {
  const sequenceRevision = input.sequenceRevision ?? 3;
  return new TaskLedgerBridge({
    sequenceLedger: {
      getSnapshot: async () => ({
        sequenceId: "seq-1",
        revision: sequenceRevision,
        nodes: [
          { taskId: "T-01", status: "pending" },
          { taskId: "T-02", status: "pending" },
        ],
        readyTaskIds: ["T-01"],
      }),
    },
    missionTaskChain: {
      getMissionStatus: async () => ({
        taskChain: {
          tasks: [
            { id: "T-01", status: "done" },
            { id: "T-02", status: "pending" },
          ],
        },
      }),
    },
    ...(input.isTransitionWired === false
      ? {}
      : {
          sequenceTransition: {
            transitionTaskStatus: async (transitionInput: {
              taskId: string;
              expectedRevision: number;
            }) => {
              input.onTransition?.(transitionInput.taskId, transitionInput.expectedRevision);
              return { revision: transitionInput.expectedRevision + 1 };
            },
          },
        }),
  });
}

function buildProposal() {
  return {
    missionIdentifier: "mission-1",
    sequenceId: "seq-1",
    sequenceRevision: 3,
    entries: [
      { taskIdentifier: "T-01", proposedAction: "mark-sequence-done" as const },
      { taskIdentifier: "T-02", proposedAction: "needs-human-review" as const },
    ],
  };
}

describe("applyWriteBackProposal", () => {
  it("只应用 mark-sequence-done，其余动作跳过并说明原因", async () => {
    const calls: string[] = [];
    const bridge = buildBridge({ onTransition: (taskId) => calls.push(taskId) });
    const result = await bridge.applyWriteBackProposal({
      proposal: buildProposal(),
      ownerAgentInstanceId: "secondary:1",
      approval: { approvedBy: "user-local", approvedAtIso: "2026-11-01T00:00:00.000Z" },
      expectedSequenceRevision: 3,
      actor: viewer,
    });
    expect(result.appliedTaskIdentifiers).toEqual(["T-01"]);
    expect(result.sequenceRevisionAfter).toBe(4);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.taskIdentifier).toBe("T-02");
    expect(calls).toEqual(["T-01"]);
  });

  it("revision 与提案不一致 ⇒ stale-revision", async () => {
    const bridge = buildBridge();
    await expect(
      bridge.applyWriteBackProposal({
        proposal: buildProposal(),
        ownerAgentInstanceId: "secondary:1",
        approval: { approvedBy: "user-local", approvedAtIso: "2026-11-01T00:00:00.000Z" },
        expectedSequenceRevision: 2,
        actor: viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("当前快照 revision 已变化 ⇒ stale-revision（防旧提案覆盖）", async () => {
    const bridge = buildBridge({ sequenceRevision: 4 });
    await expect(
      bridge.applyWriteBackProposal({
        proposal: buildProposal(),
        ownerAgentInstanceId: "secondary:1",
        approval: { approvedBy: "user-local", approvedAtIso: "2026-11-01T00:00:00.000Z" },
        expectedSequenceRevision: 3,
        actor: viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("缺人工批准或写回端口未装配 ⇒ 拒绝", async () => {
    const bridge = buildBridge();
    await expect(
      bridge.applyWriteBackProposal({
        proposal: buildProposal(),
        ownerAgentInstanceId: "secondary:1",
        approval: { approvedBy: "  ", approvedAtIso: "2026-11-01T00:00:00.000Z" },
        expectedSequenceRevision: 3,
        actor: viewer,
      }),
    ).rejects.toThrow();
    const unwired = buildBridge({ isTransitionWired: false });
    await expect(
      unwired.applyWriteBackProposal({
        proposal: buildProposal(),
        ownerAgentInstanceId: "secondary:1",
        approval: { approvedBy: "user-local", approvedAtIso: "2026-11-01T00:00:00.000Z" },
        expectedSequenceRevision: 3,
        actor: viewer,
      }),
    ).rejects.toThrow();
  });
});

/** R122：真实数据的"整 mission 节点"对齐（序列 1 节点，externalReference=mission:<id>）。 */
function buildMissionLevelBridge(input: {
  readonly nodeStatus: "pending" | "done";
  readonly missionTaskStatuses: readonly string[];
}) {
  return new TaskLedgerBridge({
    sequenceLedger: {
      getSnapshot: async () => ({
        sequenceId: "sequence-scheduler:mission-1",
        revision: 2,
        nodes: [
          {
            taskId: "task-mission-1",
            status: input.nodeStatus,
            externalReference: "mission:mission-1",
          },
        ],
        readyTaskIds: [],
      }),
    },
    missionTaskChain: {
      getMissionStatus: async () => ({
        taskChain: {
          tasks: input.missionTaskStatuses.map((status, index) => ({
            id: `T-0${String(index + 1)}`,
            status,
          })),
        },
      }),
    },
  });
}

describe("整 mission 节点的写回提案", () => {
  it("mission 全部 done + 节点 pending ⇒ mark-sequence-done（目标是序列节点 id）", async () => {
    const bridge = buildMissionLevelBridge({
      nodeStatus: "pending",
      missionTaskStatuses: ["done", "done"],
    });
    const proposal = await bridge.buildWriteBackProposal({
      missionIdentifier: "mission-1",
      ownerAgentInstanceId: "scheduler:mission-1",
      sequenceId: "sequence-scheduler:mission-1",
      viewer,
    });
    expect(proposal.entries).toHaveLength(1);
    expect(proposal.entries[0]?.taskIdentifier).toBe("task-mission-1");
    expect(proposal.entries[0]?.proposedAction).toBe("mark-sequence-done");
  });

  it("mission 未全部 done ⇒ needs-human-review（不单向推导）", async () => {
    const bridge = buildMissionLevelBridge({
      nodeStatus: "pending",
      missionTaskStatuses: ["done", "running"],
    });
    const proposal = await bridge.buildWriteBackProposal({
      missionIdentifier: "mission-1",
      ownerAgentInstanceId: "scheduler:mission-1",
      sequenceId: "sequence-scheduler:mission-1",
      viewer,
    });
    expect(proposal.entries).toHaveLength(1);
    expect(proposal.entries[0]?.proposedAction).toBe("needs-human-review");
  });

  it("序列节点已 done ⇒ 无条目（不产出噪声）", async () => {
    const bridge = buildMissionLevelBridge({
      nodeStatus: "done",
      missionTaskStatuses: ["done"],
    });
    const proposal = await bridge.buildWriteBackProposal({
      missionIdentifier: "mission-1",
      ownerAgentInstanceId: "scheduler:mission-1",
      sequenceId: "sequence-scheduler:mission-1",
      viewer,
    });
    expect(proposal.entries).toEqual([]);
  });
});
