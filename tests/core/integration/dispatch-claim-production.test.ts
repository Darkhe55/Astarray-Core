/**
 * ALIGN-02-05（2026-11-08）：**生产派发端口必须真的领取 / 释放**。
 *
 * 现状缺口（代码核对）：
 * - `createMissionDispatchPorts` 只包装 `dispatchTaskByTaskIdentifier`，
 *   **不提供** `claimTask` / `releaseTask`；
 * - 调度循环里的"领取失败 ⇒ 跳过、派发被拒 ⇒ 释放"因此**只在测试里被人工注入过**，
 *   生产上从不发生：序列任务停在 `pending`，"领取 → 失败 → 释放 → 再领取"没有闭环；
 * - `claimTask` 的 double-claim 保护也从未被生产调用。
 *
 * 本文件钉住两件事：
 * 1. 端口工厂**必须**接受并透传 claim/release（缺省没有静默 true）；
 * 2. 领取真的落到权威序列上（running），被拒后真的回到 pending。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import {
  SecondaryContinuousDispatchLoop,
  createMissionDispatchPorts,
} from "../../../packages/core/src/orchestration/secondary-continuous-dispatch-loop.js";
import {
  TaskSequenceManageController,
  TaskSequenceStatusController,
} from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import { UnboundedAgentInstanceRegistry } from "../../../packages/core/src/orchestration/unbounded-agent-registry.js";

let temporaryDirectory: string;
let store: AgentTaskSequenceStore;
let manage: TaskSequenceManageController;
let status: TaskSequenceStatusController;

const owner = "secondary-agent-1";
const sequenceId = `sequence-${owner}`;
const viewer = { sourceKind: "user" as const, actorId: "user-1" };

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-claim-"));
  store = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
  manage = new TaskSequenceManageController(store);
  status = new TaskSequenceStatusController(store);
  await manage.publishSequence({
    ownerAgentInstanceId: owner,
    actor: viewer,
    sequenceId,
    firstTask: {
      taskId: "task-1",
      title: "任务 1",
      priorityTier: 0,
      externalReference: null,
    },
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function taskStatusOf(taskId: string): Promise<string | undefined> {
  const snapshot = await status.getSnapshot({
    ownerAgentInstanceId: owner,
    sequenceId,
    viewer,
  });
  return snapshot.nodes.find((node) => node.taskId === taskId)?.status;
}

function productionPorts(dispatcherOutcome: "accepted" | "refused") {
  return createMissionDispatchPorts({
    dispatchTaskByTaskIdentifier: () => ({ outcome: dispatcherOutcome }),
    claimTask: (taskId) =>
      manage.claimTask({ ownerAgentInstanceId: owner, sequenceId, taskId }),
    releaseTask: async (taskId) => {
      await manage.releaseClaim({ ownerAgentInstanceId: owner, sequenceId, taskId });
    },
  });
}

describe("生产派发端口：领取与释放（ALIGN-02-05）", () => {
  it("端口工厂透传 claim/release；领取真的把序列任务置为 running", async () => {
    const ports = productionPorts("accepted");
    expect(typeof ports.claimTask).toBe("function");
    expect(typeof ports.releaseTask).toBe("function");

    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 1,
      maxQueueLength: 1,
    });
    const loop = new SecondaryContinuousDispatchLoop({ registry });
    loop.registerMissionPorts("mission-1", ports);
    const round = await loop.runRound({
      nodes: [
        { taskId: "task-1", status: "pending", dependsOn: [], priorityTier: 0 },
      ] as never,
      missionIdentifier: "mission-1",
    });
    expect(round.dispatchedTaskIds).toEqual(["task-1"]);
    expect(await taskStatusOf("task-1")).toBe("running");
  });

  it("派发被拒 ⇒ 领取被释放（任务回到 pending，占用回落）", async () => {
    const registry = new UnboundedAgentInstanceRegistry({
      maxConcurrentSlots: 1,
      maxQueueLength: 1,
    });
    const loop = new SecondaryContinuousDispatchLoop({ registry });
    loop.registerMissionPorts("mission-2", productionPorts("refused"));
    const round = await loop.runRound({
      nodes: [
        { taskId: "task-1", status: "pending", dependsOn: [], priorityTier: 0 },
      ] as never,
      missionIdentifier: "mission-2",
    });
    expect(round.dispatchedTaskIds).toEqual([]);
    expect(round.skippedReasons["task-1"]).toContain("派发被拒绝");
    expect(await taskStatusOf("task-1")).toBe("pending");
    expect(registry.getOccupiedSlotCount()).toBe(0);
  });

  it("同一任务重复领取只成功一次（不重复派发）", async () => {
    expect(
      await manage.claimTask({ ownerAgentInstanceId: owner, sequenceId, taskId: "task-1" }),
    ).toBe(true);
    expect(
      await manage.claimTask({ ownerAgentInstanceId: owner, sequenceId, taskId: "task-1" }),
    ).toBe(false);
  });
});
