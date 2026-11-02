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
  graphChangeJournal?: {
    append(entry: {
      readonly missionIdentifier: string;
      readonly changeKind: "inject" | "remove" | "revise" | "rewire";
      readonly taskIdentifier: string;
      readonly recordedAtIso: string;
      readonly before: {
        readonly dependsOn: readonly string[];
        readonly description: string;
        readonly toolNames: readonly string[];
      } | null;
      readonly after: {
        readonly dependsOn: readonly string[];
        readonly description: string;
        readonly toolNames: readonly string[];
      } | null;
    }): Promise<void>;
  },
  onGraphChanged?: (event: {
    readonly changeKind: "inject" | "remove" | "revise" | "rewire";
    readonly taskIdentifier: string;
  }) => void,
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
    ...(graphChangeJournal === undefined ? {} : { graphChangeJournal }),
    ...(onGraphChanged === undefined ? {} : { onGraphChanged }),
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

describe("显式乱序派发（allowUnmetDependencies）", () => {
  it("请求乱序 ⇒ 依赖未完成也先启动该任务；依赖任务保持 pending", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"])],
      1,
    );
    const decision = scheduler.preferTaskDispatch("t2", {
      allowUnmetDependencies: true,
    });
    expect(decision.outcome).toBe("accepted");
    expect(decision.reasonCode).toBe("forced-dispatch");
    const round = await scheduler.scheduleRound();
    const started = round.filter((action) => action.action === "start-task");
    expect(started.map((action) => action.taskId)).toEqual(["t2"]);
    const chain = await taskStore.readTaskChain("mission-prefer");
    const t1 = chain?.tasks.find((task) => task.id === "t1");
    expect(t1?.status).toBe("pending");
  });

  it("未请求乱序时仍拒绝依赖未完成", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"])],
      1,
    );
    expect(scheduler.preferTaskDispatch("t2").reasonCode).toBe("dependencies-unmet");
  });
});

describe("运行中修订 pending 任务（R129）", () => {
  it("修订 description/toolNames 并持久化；运行中任务被拒", async () => {
    const scheduler = await createScheduler([makeNode("t1"), makeNode("t2")], 1);
    const revised = await scheduler.revisePendingTask("t2", {
      description: "新的任务描述",
      toolNames: ["write"],
    });
    expect(revised.outcome).toBe("revised");
    const chain = await taskStore.readTaskChain("mission-prefer");
    const t2 = chain?.tasks.find((task) => task.id === "t2");
    expect(t2?.description).toBe("新的任务描述");
    expect(t2?.toolNames).toEqual(["write"]);

    await scheduler.scheduleRound();
    const refused = await scheduler.revisePendingTask("t1", {
      description: "运行中改需求",
    });
    expect(refused.outcome).toBe("refused");
    expect(refused.reasonCode).toBe("task-not-pending");
  });
});

describe("安全点注入/删除（R130）", () => {
  it("安全点注入新任务并落盘；重复 ID 被拒；有在途任务时拒绝", async () => {
    const scheduler = await createScheduler([makeNode("t1")], 1);
    const injected = await scheduler.injectTaskChecked(makeNode("t9"));
    expect(injected.outcome).toBe("injected");
    const chain = await taskStore.readTaskChain("mission-prefer");
    expect(chain?.tasks.map((task) => task.id)).toContain("t9");

    const duplicate = await scheduler.injectTaskChecked(makeNode("t9"));
    expect(duplicate.outcome).toBe("refused");

    await scheduler.scheduleRound();
    const notSafe = await scheduler.injectTaskChecked(makeNode("t10"));
    expect(notSafe.reasonCode).toBe("not-safe-point");
  });

  it("删除 pending 叶子成功；被依赖或运行中的任务被拒", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", ["t1"]), makeNode("t3")],
      1,
    );
    const removed = await scheduler.removePendingTask("t3");
    expect(removed.outcome).toBe("removed");
    const chain = await taskStore.readTaskChain("mission-prefer");
    expect(chain?.tasks.map((task) => task.id)).not.toContain("t3");

    const dependent = await scheduler.removePendingTask("t1");
    expect(dependent.outcome).toBe("refused");

    await scheduler.scheduleRound();
    const running = await scheduler.removePendingTask("t1");
    expect(running.outcome).toBe("refused");
    expect(running.reasonCode).toBe("task-running");
  });
});

describe("安全点重连依赖（R131）", () => {
  it("重连后下游可运行；环被拒且回滚；未知依赖被拒", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1"), makeNode("t2", [], "done"), makeNode("t3", ["t1"])],
      1,
    );
    /** 先制造环：t3 依赖 t1，若把 t1 改依赖 t3 会成环 ⇒ 拒绝且回滚。 */
    const cycle = await scheduler.rewireTaskDependencies("t1", ["t3"]);
    expect(cycle.outcome).toBe("refused");
    const afterCycle = await taskStore.readTaskChain("mission-prefer");
    expect(afterCycle?.tasks.find((task) => task.id === "t1")?.dependsOn).toEqual([]);

    const rewired = await scheduler.rewireTaskDependencies("t3", ["t2"]);
    expect(rewired.outcome).toBe("rewired");
    const chain = await taskStore.readTaskChain("mission-prefer");
    expect(chain?.tasks.find((task) => task.id === "t3")?.dependsOn).toEqual(["t2"]);

    const unknown = await scheduler.rewireTaskDependencies("t3", ["t404"]);
    expect(unknown.outcome).toBe("refused");
  });

  it("blocked 任务重连到已满足依赖 ⇒ 自动回到 pending", async () => {
    const scheduler = await createScheduler(
      [makeNode("t1", [], "done"), makeNode("t2", ["t1"], "blocked")],
      1,
    );
    const rewired = await scheduler.rewireTaskDependencies("t2", ["t1"]);
    expect(rewired.outcome).toBe("rewired");
    const chain = await taskStore.readTaskChain("mission-prefer");
    expect(chain?.tasks.find((task) => task.id === "t2")?.status).toBe("pending");
  });

  it("有在途任务时拒绝重连（not-safe-point）", async () => {
    const scheduler = await createScheduler([makeNode("t1"), makeNode("t2")], 1);
    await scheduler.scheduleRound();
    const refused = await scheduler.rewireTaskDependencies("t2", ["t1"]);
    expect(refused.reasonCode).toBe("not-safe-point");
  });
});

describe("图变更审计（R132）", () => {
  it("注入/重连各写一条变更，含 before/after", async () => {
    const entries: {
      changeKind: string;
      taskIdentifier: string;
      before: { dependsOn: readonly string[] } | null;
      after: { dependsOn: readonly string[] } | null;
      missionIdentifier: string;
    }[] = [];
    const scheduler = await createScheduler([makeNode("t1")], 1, {
      append: async (entry) => {
        entries.push(entry as never);
      },
    });
    await scheduler.injectTaskChecked(makeNode("t9"));
    await scheduler.rewireTaskDependencies("t9", ["t1"]);
    const kinds = entries.map((entry) => entry.changeKind);
    expect(kinds).toEqual(["inject", "rewire"]);
    expect(entries[0]?.before).toBeNull();
    expect(entries[0]?.after?.dependsOn).toEqual([]);
    expect(entries[1]?.before?.dependsOn).toEqual([]);
    expect(entries[1]?.after?.dependsOn).toEqual(["t1"]);
    expect(entries[1]?.missionIdentifier).toBe("mission-prefer");
  });
});

describe("图变更通知（R133）", () => {
  it("注入/重连各触发一次通知", async () => {
    const events: string[] = [];
    const scheduler = await createScheduler(
      [makeNode("t1")],
      1,
      undefined,
      (event) => {
        events.push(`${event.changeKind}:${event.taskIdentifier}`);
      },
    );
    await scheduler.injectTaskChecked(makeNode("t9"));
    await scheduler.rewireTaskDependencies("t9", ["t1"]);
    expect(events).toEqual(["inject:t9", "rewire:t9"]);
  });
});
