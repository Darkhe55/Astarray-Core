/**
 * ALIGN-02-03（2026-11-08）：调度器必须消费 ready set 的**有效优先级 + 稳定顺序**。
 *
 * 现状问题：`TaskGraph.findRunnableTaskIds()` 按 **taskId 字典序**排序（`sort()`），
 * 完全忽略 `priorityTier` 与创建顺序 ⇒ 用户层任务可能排在 Agent 派生任务之后，
 * 同层顺序也是字典序而非"先声明先执行"。
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
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ready-order-"));
  taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  agentIdSequence = 0;
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

function makeNode(
  id: string,
  overrides: Partial<TaskDependencyNode> = {},
): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn: [],
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
    ...overrides,
  };
}

async function createScheduler(
  nodes: TaskDependencyNode[],
  concurrency: number,
): Promise<DagScheduler> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: "mission-ready-order",
    revision: 1,
    updatedAtIso: "2026-11-08T10:00:00.000Z",
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

function startedTaskIds(actions: Awaited<ReturnType<DagScheduler["scheduleRound"]>>): string[] {
  return actions
    .filter((action): action is { action: "start-task"; taskId: string; assignedAgentId: string } =>
      action.action === "start-task",
    )
    .map((action) => action.taskId);
}

describe("ready set 顺序（ALIGN-02-03）", () => {
  it("用户层（tier 0）先于 Agent 派生（tier 1），即使字典序相反", async () => {
    const scheduler = await createScheduler(
      [
        makeNode("zzz-agent-derived", { priorityTier: 1 }),
        makeNode("aaa-user-task", { priorityTier: 0 }),
      ],
      1,
    );
    expect(startedTaskIds(await scheduler.scheduleRound())).toEqual(["aaa-user-task"]);
  });

  it("同层按创建顺序（先声明先执行），不按字典序", async () => {
    const scheduler = await createScheduler(
      [
        makeNode("z-first-declared", { priorityTier: 1 }),
        makeNode("a-second-declared", { priorityTier: 1 }),
      ],
      2,
    );
    expect(startedTaskIds(await scheduler.scheduleRound())).toEqual([
      "z-first-declared",
      "a-second-declared",
    ]);
  });

  it("有效优先级：有紧急后继的节点先跑（min(自身, 可达后继)）", async () => {
    const scheduler = await createScheduler(
      [
        makeNode("later-free", { priorityTier: 1 }),
        makeNode("gate", { priorityTier: 2 }),
        makeNode("urgent-successor", { dependsOn: ["gate"], priorityTier: 0 }),
      ],
      1,
    );
    /** gate 的有效优先级被后继拉高到 0；urgent-successor 依赖未满足，不得启动。 */
    expect(startedTaskIds(await scheduler.scheduleRound())).toEqual(["gate"]);
  });

  it("未满足依赖的任务永不被置顶或强制乱序派发绕过", async () => {
    const scheduler = await createScheduler(
      [
        makeNode("prerequisite", { priorityTier: 1 }),
        makeNode("dependent", { dependsOn: ["prerequisite"], priorityTier: 0 }),
      ],
      2,
    );
    expect(startedTaskIds(await scheduler.scheduleRound())).toEqual(["prerequisite"]);
    await scheduler.finishTask("prerequisite", "done", null);
    expect(startedTaskIds(await scheduler.scheduleRound())).toEqual(["dependent"]);
  });

  it("选择是确定性的：重复构造同一任务链得到相同顺序", async () => {
    const nodes = [
      makeNode("b", { priorityTier: 1 }),
      makeNode("c", { priorityTier: 0 }),
      makeNode("a", { priorityTier: 1 }),
    ];
    /**
     * 同一目录只能有一份任务链（TaskStore 拒绝旧 revision 覆盖）：
     * 这里用两个独立目录比较"同输入同顺序"，并各自清掉目录。
     */
    const first = startedTaskIds(await (await createScheduler(nodes, 3)).scheduleRound());
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-ready-order-"));
    taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
    const second = startedTaskIds(await (await createScheduler(nodes, 3)).scheduleRound());
    expect(first).toEqual(second);
    expect(first).toEqual(["c", "b", "a"]);
  });
});
