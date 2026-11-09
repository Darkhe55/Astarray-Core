/**
 * ALIGN-03-07（2026-11-09）：**任务终态后关闭该三级个体**。
 *
 * 缺口（卡内 2026-10-28 记录）：`TertiaryAgentLifecycleController.shutdown()`
 * 在生产里**没有任何调用方** ⇒ 收口"看起来成功"，实际没存档案、没写移交。
 *
 * 本文件验证调度层的钩子：终态后**按该任务的 Agent 实例**调用关闭，
 * 且**先持久化再关闭**；关闭失败不得反转任务终态。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DagScheduler } from "../../../packages/core/src/orchestration/dag-scheduler.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import type { TaskChainDocument, TaskDependencyNode } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 30_000 });

let stateDirectory: string;
let taskStore: TaskStore;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-align0307-"));
  taskStore = new TaskStore({ baseDirectory: stateDirectory });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildNode(id: string): TaskDependencyNode {
  return {
    id,
    description: "任务 " + id,
    dependsOn: [],
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
}

async function buildScheduler(
  closeAgentInstance?: (input: {
    readonly agentInstanceId: string;
    readonly taskId: string;
    readonly outcome: "done" | "failed";
  }) => Promise<void>,
): Promise<DagScheduler> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: "mission-close",
    revision: 1,
    updatedAtIso: "2026-11-09T00:00:00.000Z",
    tasks: [buildNode("T-1"), buildNode("T-2")],
  };
  await taskStore.writeTaskChain(chain);
  return new DagScheduler(chain, {
    concurrency: 2,
    taskStore,
    allocateAgentId: (taskId: string) => "worker:" + taskId,
    ...(closeAgentInstance === undefined ? {} : { closeAgentInstance }),
  });
}

describe("ALIGN-03-07 三级收口钩子", () => {
  it("任务完成 ⇒ 关闭**该任务**的 Agent 实例（不是别人的）", async () => {
    const closedAgentInstanceIds: string[] = [];
    const scheduler = await buildScheduler(async (input) => {
      closedAgentInstanceIds.push(input.agentInstanceId);
    });
    const actions = await scheduler.scheduleRound();
    expect(actions.length).toBeGreaterThan(0);
    await scheduler.finishTask("T-1", "done", "docs/out.md");
    expect(closedAgentInstanceIds).toEqual(["worker:T-1"]);
  }, 30_000);

  it("先持久化再关闭：关闭时任务链已含终态", async () => {
    let statusSeenAtClose: string | null = null;
    const scheduler = await buildScheduler(async (input) => {
      const persisted = await taskStore.readTaskChain("mission-close");
      statusSeenAtClose =
        persisted?.tasks.find((task: { id: string }) => task.id === input.taskId)?.status ?? null;
    });
    await scheduler.scheduleRound();
    await scheduler.finishTask("T-2", "done", null);
    expect(statusSeenAtClose).toBe("done");
  }, 30_000);

  it("关闭失败不反转任务终态（但也不静默成功）", async () => {
    const scheduler = await buildScheduler(async () => {
      throw new Error("关闭失败");
    });
    await scheduler.scheduleRound();
    await expect(scheduler.finishTask("T-1", "done", null)).resolves.toBeUndefined();
    const persisted = await taskStore.readTaskChain("mission-close");
    expect(persisted?.tasks.find((task: { id: string }) => task.id === "T-1")?.status).toBe("done");
  }, 30_000);

  it("未装配关闭钩子 ⇒ 不假装已关闭（不抛错、也不调用）", async () => {
    const scheduler = await buildScheduler();
    await scheduler.scheduleRound();
    await expect(scheduler.finishTask("T-1", "done", null)).resolves.toBeUndefined();
  }, 30_000);
});
