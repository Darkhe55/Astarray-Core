/**
 * R135（2026-11-02）：图变更审计存储 + 调度器接线（真实 store，无 mock）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskChainDocument, TaskDependencyNode } from "../../packages/core/src/core/types.js";
import { TaskStore } from "../../packages/core/src/infra/task-store.js";
import { DagScheduler } from "../../packages/core/src/orchestration/dag-scheduler.js";
import { TaskGraphChangeJournalStore } from "../../packages/core/src/orchestration/task-graph-change-journal.js";

let temporaryDirectory: string;
let taskStore: TaskStore;
let agentIdSequence: number;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "astarray-graph-journal-"));
  taskStore = new TaskStore({ baseDirectory: temporaryDirectory });
  agentIdSequence = 0;
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function makeNode(id: string, dependsOn: string[] = []): TaskDependencyNode {
  return {
    id,
    description: `任务 ${id}`,
    dependsOn,
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
}

async function createScheduler(
  nodes: TaskDependencyNode[],
  journal: TaskGraphChangeJournalStore,
): Promise<DagScheduler> {
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: "mission-journal",
    revision: 1,
    updatedAtIso: "2026-11-02T00:00:00.000Z",
    tasks: nodes,
  };
  await taskStore.writeTaskChain(chain);
  return new DagScheduler(chain, {
    concurrency: 1,
    taskStore,
    allocateAgentId: () => {
      agentIdSequence += 1;
      return `L3-${agentIdSequence}`;
    },
    graphChangeJournal: journal,
  });
}

describe("图变更审计（真实存储）", () => {
  it("调度器注入后写入归档，可按 mission 读回", async () => {
    const journal = new TaskGraphChangeJournalStore({
      baseDirectory: temporaryDirectory,
    });
    const scheduler = await createScheduler([makeNode("t1")], journal);
    await scheduler.injectTaskChecked(makeNode("t9"));
    const entries = await journal.listForMission("mission-journal");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.changeKind).toBe("inject");
    expect(entries[0]?.taskIdentifier).toBe("t9");
    expect(entries[0]?.before).toBeNull();
    expect(entries[0]?.after?.dependsOn).toEqual([]);
  });

  it("读取时跳过坏行，只返回本 mission", async () => {
    const journal = new TaskGraphChangeJournalStore({
      baseDirectory: temporaryDirectory,
    });
    const scheduler = await createScheduler([makeNode("t1")], journal);
    await scheduler.injectTaskChecked(makeNode("t9"));
    await writeFile(
      path.join(temporaryDirectory, "task-graph-changes.jsonl"),
      '{"missionIdentifier":"mission-journal","changeKind":"inject","taskIdentifier":"tBROKEN"\n',
      { flag: "a" },
    );
    const entries = await journal.listForMission("mission-journal");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskIdentifier).toBe("t9");
  });
});
