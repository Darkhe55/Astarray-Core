/**
 * B9（2026-11-24）：`TaskLedgerBridge` 的错误/边界分支（注入端口，无文件系统）。
 *
 * 覆盖：写回批准校验、mission 缺失、单任务预检的六种阻塞原因、
 * 提案映射过期（序列节点/ mission 任务不存在）的 notes。
 */
import { describe, expect, it } from "vitest";

import {
  TaskLedgerBridge,
  type MissionTaskChainPort,
  type TaskSequenceLedgerPort,
} from "../../../packages/core/src/orchestration/task-ledger-bridge.js";
import type { ActorIdentity } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";

const viewer: ActorIdentity = { sourceKind: "user", actorId: "user-1" };

function bridgeWith(input: {
  nodes?: Array<{ taskId: string; status: string }>;
  readyTaskIds?: string[];
  missionTasks?: Array<{ id: string; status: string }> | null;
  mappings?: Array<{ missionTaskIdentifier: string; sequenceTaskIdentifier: string }>;
  withTransition?: boolean;
}): TaskLedgerBridge {
  const sequenceLedger: TaskSequenceLedgerPort = {
    getSnapshot: async () => ({
      sequenceId: "seq-1",
      revision: 5,
      nodes: input.nodes ?? [],
      readyTaskIds: input.readyTaskIds ?? [],
    }),
  };
  const missionTaskChain: MissionTaskChainPort = {
    getMissionStatus: async () => ({
      taskChain:
        input.missionTasks === null
          ? null
          : { tasks: input.missionTasks ?? [] },
    }),
  };
  return new TaskLedgerBridge({
    sequenceLedger,
    missionTaskChain,
    ...(input.mappings === undefined
      ? {}
      : {
          taskMappings: {
            listForMission: async () => input.mappings!,
          },
        }),
    ...(input.withTransition === true
      ? {
          sequenceTransition: {
            transitionTaskStatus: async (parameters) => ({
              revision: parameters.expectedRevision + 1,
            }),
          },
        }
      : {}),
  });
}

describe("B9：TaskLedgerBridge 边界", () => {
  it("① 对照时 mission 无任务链 ⇒ mission-not-found", async () => {
    const bridge = bridgeWith({ missionTasks: null });
    await expect(
      bridge.inspectAlignment({
        missionIdentifier: "m-1",
        ownerAgentInstanceId: "owner",
        sequenceId: "seq-1",
        viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "mission-not-found" });
  });

  it("② 预检：mission 无任务链 ⇒ mission-not-found", async () => {
    const bridge = bridgeWith({ missionTasks: null });
    await expect(
      bridge.inspectSingleTaskDispatchPrecheck({
        missionIdentifier: "m-1",
        taskIdentifier: "T-1",
        ownerAgentInstanceId: "owner",
        sequenceId: "seq-1",
        viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "mission-not-found" });
  });

  it("③ 预检：任务不在序列 / 不在 mission，分别给出原因", async () => {
    const bridge = bridgeWith({
      nodes: [{ taskId: "T-1", status: "pending" }],
      readyTaskIds: ["T-1"],
      missionTasks: [{ id: "T-2", status: "pending" }],
    });
    const precheck = await bridge.inspectSingleTaskDispatchPrecheck({
      missionIdentifier: "m-1",
      taskIdentifier: "T-3",
      ownerAgentInstanceId: "owner",
      sequenceId: "seq-1",
      viewer,
    });
    expect(precheck.isDispatchable).toBe(false);
    expect(precheck.blockedReasons.join("；")).toContain("不在权威序列中");
    expect(precheck.blockedReasons.join("；")).toContain("不在 mission 任务链中");
    expect(precheck.capabilities.canDispatchTaskByTaskIdentifier).toBe(false);
  });

  it("④ 预检：两侧状态不一致 / 未 ready / mission 非 pending 各一条原因", async () => {
    const bridge = bridgeWith({
      nodes: [{ taskId: "T-1", status: "done" }],
      readyTaskIds: [],
      missionTasks: [{ id: "T-1", status: "blocked" }],
    });
    const precheck = await bridge.inspectSingleTaskDispatchPrecheck({
      missionIdentifier: "m-1",
      taskIdentifier: "T-1",
      ownerAgentInstanceId: "owner",
      sequenceId: "seq-1",
      viewer,
    });
    expect(precheck.isDispatchable).toBe(false);
    const joined = precheck.blockedReasons.join("；");
    expect(joined).toContain("状态");
    expect(joined).toContain("未 ready");
    expect(joined).toContain("不是可派发的 pending");
    expect(precheck.sequenceStatus).toBe("done");
    expect(precheck.missionStatus).toBe("blocked");
  });

  it("⑤ 预检：两侧一致且 ready ⇒ 通过，但仍声明「不能按 taskId 派发」", async () => {
    const bridge = bridgeWith({
      nodes: [{ taskId: "T-1", status: "pending" }],
      readyTaskIds: ["T-1"],
      missionTasks: [{ id: "T-1", status: "pending" }],
    });
    const precheck = await bridge.inspectSingleTaskDispatchPrecheck({
      missionIdentifier: "m-1",
      taskIdentifier: "T-1",
      ownerAgentInstanceId: "owner",
      sequenceId: "seq-1",
      viewer,
    });
    expect(precheck.isDispatchable).toBe(true);
    expect(precheck.blockedReasons).toEqual([]);
    expect(precheck.capabilities.note).toContain("不等");
  });

  it("⑥ 写回：端口未装配 / 批准人为空 / 时间非法 / 陈旧 revision 分别拒绝", async () => {
    const bridge = bridgeWith({});
    const baseProposal = {
      missionIdentifier: "m-1",
      sequenceId: "seq-1",
      sequenceRevision: 5,
      entries: [{ taskIdentifier: "T-1", proposedAction: "mark-sequence-done" as const }],
    };
    await expect(
      bridge.applyWriteBackProposal({
        proposal: baseProposal,
        ownerAgentInstanceId: "owner",
        approval: { approvedBy: "user-1", approvedAtIso: new Date().toISOString() },
        expectedSequenceRevision: 5,
        actor: viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });

    const withPort = bridgeWith({ withTransition: true });
    await expect(
      withPort.applyWriteBackProposal({
        proposal: baseProposal,
        ownerAgentInstanceId: "owner",
        approval: { approvedBy: "  ", approvedAtIso: new Date().toISOString() },
        expectedSequenceRevision: 5,
        actor: viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });

    await expect(
      withPort.applyWriteBackProposal({
        proposal: baseProposal,
        ownerAgentInstanceId: "owner",
        approval: { approvedBy: "user-1", approvedAtIso: "not-a-time" },
        expectedSequenceRevision: 5,
        actor: viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });

    await expect(
      withPort.applyWriteBackProposal({
        proposal: baseProposal,
        ownerAgentInstanceId: "owner",
        approval: { approvedBy: "user-1", approvedAtIso: new Date().toISOString() },
        expectedSequenceRevision: 4,
        actor: viewer,
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
  });

  it("⑦ 提案：映射过期（两侧都不存在）⇒ notes 明示，不猜状态", async () => {
    const bridge = bridgeWith({
      nodes: [{ taskId: "T-1", status: "done" }],
      missionTasks: [{ id: "T-1", status: "done" }],
      mappings: [
        { missionTaskIdentifier: "M-9", sequenceTaskIdentifier: "S-9" },
        { missionTaskIdentifier: "M-8", sequenceTaskIdentifier: "S-8" },
      ],
    });
    const proposal = await bridge.buildWriteBackProposal({
      missionIdentifier: "m-1",
      ownerAgentInstanceId: "owner",
      sequenceId: "seq-1",
      viewer,
    });
    expect(proposal.isExecutable).toBe(false);
    const notes = proposal.notes.join("；");
    expect(notes).toContain("序列节点不存在");
    expect(proposal.notes.length).toBeGreaterThan(0);
  });
});
