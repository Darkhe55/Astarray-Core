/**
 * D2（2026-11-23 产品裁决）：**派发前已取消的序列节点不得启动**——真实派发入口反例。
 *
 * 派发入口 = `SecondaryContinuousDispatchLoop.runRound`（按权威序列 ready set 派发）：
 * - 已取消节点不在 ready set ⇒ 派发回调不会收到它；
 * - 可派发对照节点照常派发（防止"全部不派发也通过"的假绿）；
 * - 以"每次派发写一个提案文件"模拟 worker 的真实副作用：取消节点新增文件数为 0。
 */
import { describe, expect, it } from "vitest";

import { UnboundedAgentInstanceRegistry } from "../../../packages/core/src/orchestration/unbounded-agent-registry.js";
import { SecondaryContinuousDispatchLoop } from "../../../packages/core/src/orchestration/secondary-continuous-dispatch-loop.js";
import type { AgentTaskNode } from "../../../packages/core/src/core/types.js";

function makeNode(
  taskId: string,
  status: AgentTaskNode["status"],
  dependsOn: string[] = [],
): AgentTaskNode {
  return {
    taskId,
    title: `任务 ${taskId}`,
    dependsOn,
    sourceKind: "user",
    publisherId: "user-1",
    priorityTier: 0,
    status,
    blockReason: null,
    externalReference: null,
    sequenceOrdinal: 1,
    createdAtIso: "2026-11-23T00:00:00.000Z",
  };
}

function makeLoop(onDispatch: (taskId: string) => void) {
  const registry = new UnboundedAgentInstanceRegistry({
    maxConcurrentSlots: 4,
    maxQueueLength: 4,
    currentOccupiedSlots: () => 0,
  });
  return new SecondaryContinuousDispatchLoop({
    registry,
    dispatchChain: async (chain) => {
      for (const taskId of chain.taskIds) {
        onDispatch(taskId);
      }
      return true;
    },
    currentOccupiedSlots: () => 0,
  });
}

describe("D2：已取消节点在真实派发入口不启动", () => {
  it("① 取消节点不派发；可派发对照节点照常派发（提案文件只为对照产生）", async () => {
    const startedTaskIds: string[] = [];
    /** 模拟"worker 启动即写一份目标提案文件"：按派发次数计数。 */
    const proposalFiles: string[] = [];
    const loop = makeLoop((taskId) => {
      startedTaskIds.push(taskId);
      proposalFiles.push(`${taskId}.proposal.json`);
    });
    const nodes = [makeNode("T-ok", "pending"), makeNode("T-cancelled", "cancelled")];

    const round = await loop.runRound({ nodes });
    expect(round.dispatchedTaskIds).toEqual(["T-ok"]);
    expect(startedTaskIds).toEqual(["T-ok"]);
    expect(proposalFiles).toEqual(["T-ok.proposal.json"]);
    expect(proposalFiles.filter((file) => file.startsWith("T-cancelled"))).toEqual([]);
    expect(round.skippedReasons).not.toHaveProperty("T-cancelled");
  });

  it("② 全部节点已取消 ⇒ 零派发、零提案文件（且原因是无 ready 工作而非隐藏）", async () => {
    const startedTaskIds: string[] = [];
    const proposalFiles: string[] = [];
    const loop = makeLoop((taskId) => {
      startedTaskIds.push(taskId);
      proposalFiles.push(`${taskId}.proposal.json`);
    });
    const round = await loop.runRound({
      nodes: [makeNode("T-c1", "cancelled"), makeNode("T-c2", "cancelled")],
    });
    expect(round.dispatchedTaskIds).toEqual([]);
    expect(startedTaskIds).toEqual([]);
    expect(proposalFiles).toEqual([]);
    expect(round.blockedReason).toBeNull();
  });

  it("③ 取消节点即使依赖已完成也不复活（依赖满足不改变取消语义）", async () => {
    const startedTaskIds: string[] = [];
    const loop = makeLoop((taskId) => startedTaskIds.push(taskId));
    const round = await loop.runRound({
      nodes: [makeNode("T-dep", "done"), makeNode("T-cancelled", "cancelled", ["T-dep"])],
    });
    expect(round.dispatchedTaskIds).toEqual([]);
    expect(startedTaskIds).toEqual([]);
  });

  it("④ 对照：同一批节点里未取消的那条被派发一次（不是零派发的假绿）", async () => {
    const startedTaskIds: string[] = [];
    const loop = makeLoop((taskId) => startedTaskIds.push(taskId));
    const round = await loop.runRound({
      nodes: [makeNode("T-dep", "done"), makeNode("T-ok", "pending", ["T-dep"])],
    });
    expect(round.dispatchedTaskIds).toEqual(["T-ok"]);
    expect(startedTaskIds).toEqual(["T-ok"]);
  });
});
