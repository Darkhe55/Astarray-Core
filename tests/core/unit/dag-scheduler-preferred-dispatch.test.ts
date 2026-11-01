/**
 * R126（2026-11-01）：按 taskId 优先派发的单测。
 *
 * - 合法任务 ⇒ accepted，下一轮优先启动；
 * - 依赖未完成/不存在/已运行 ⇒ 拒绝并给原因；
 * - 优先只影响顺序，不绕过依赖。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskChainDocument, TaskDependencyNode } from "../../../packages/core/src/core/types.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { DagScheduler } from "../../../packages/core/src/orchestration/dag-scheduler.js";

let temporaryDirectory: string;
let taskStore: TaskStore;
let agentIdSequence: number;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-prefer-"));
  taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  agentIdSequence = 0;
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeNode(
  id: string,
  dependsOn: string[] = [],
  status: TaskDependencyNode["status"] = "pending",
): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn,
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status,
    resultLocation: null,
  };
}

async function createScheduler(
  nodes: TaskDependencyNode[],
  concurrency: number,
): Promise<DagScheduler> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: "mission-prefer",
    revision: 1,
    updatedAtIso: "2026-08-12T10:00:00.000Z",
    tasks: nodes,
  };
  await taskStore.writeTaskChain(chain);
  return new DagScheduler(chain, {
    concurrency,
    taskStore,
    allocateAgentId: () => {
      agentIdSequence += 1;
      return `L3-${agentIdSequence}`;
    },
  });
}

describe("按 taskId 优先派发", () => {
  it("接受后下一轮优先启动该任务（不改变依赖约束）", async () => {
    const scheduler = await createScheduler([makeNode("t1"), makeNode("t2")], 1);
    const decision = scheduler.preferTaskDispatch("t2");
    expect(decision.outcome).toBe("accepted");
    const round = await scheduler.scheduleRound();
    const started = round.filter((action) => action.action === "start-task");
    expect(started).toHaveLength(1);
    expect(started[0]?.taskId).toBe("t2");
  });

  it("依赖未完成 ⇒ 拒绝（不绕过依赖）", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"])],
      2,
    );
    const decision = scheduler.preferTaskDispatch("t2");
    expect(decision.outcome).toBe("refused");
    expect(decision.reasonCode).toBe("dependencies-unmet");
  });

  it("不存在/已在运行的任务 ⇒ 拒绝", async () => {
    const scheduler = await createScheduler([makeNode("t1"), makeNode("t2")], 1);
    expect(scheduler.preferTaskDispatch("missing").reasonCode).toBe("task-not-found");
    await scheduler.scheduleRound();
    expect(scheduler.preferTaskDispatch("t1").reasonCode).toBe("task-already-running");
  });
});
