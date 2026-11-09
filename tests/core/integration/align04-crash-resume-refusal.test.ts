/**
 * ALIGN-04-03（2026-11-09）：**崩溃留下的 running 任务 ⇒ 拒绝自动恢复**。
 *
 * 卡内 2026-10-28 记录"未跑'崩溃 running ⇒ 拒绝恢复'任何一条"。
 * 本文件用**只读投影**（`inspectMissionResumeReadiness`）验证该语义：
 * 不启动真实 mission，只把任务链写进存储，再问"能不能自动恢复"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import type { TaskChainDocument, TaskDependencyNode } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;
const MISSION_ID = "mission-crash-running";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-align0403-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildNode(
  id: string,
  status: TaskDependencyNode["status"],
  extra: Partial<TaskDependencyNode> = {},
): TaskDependencyNode {
  return {
    id,
    description: "任务 " + id,
    dependsOn: [],
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status,
    resultLocation: null,
    ...extra,
  };
}

async function writeChain(nodes: TaskDependencyNode[]): Promise<void> {
  const store = new TaskStore({ baseDirectory: stateDirectory });
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: MISSION_ID,
    revision: 1,
    updatedAtIso: "2026-11-09T00:00:00.000Z",
    tasks: nodes,
  };
  await store.writeTaskChain(chain);
}

async function inspect() {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
  });
  try {
    return await runtime.controller.inspectMissionResumeReadiness(MISSION_ID);
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("ALIGN-04-03 崩溃后的恢复就绪判定", () => {
  it("**崩溃留下 running** ⇒ 不可自动恢复，且该任务被列为副作用未知", async () => {
    await writeChain([buildNode("T-1", "done"), buildNode("T-2", "running")]);
    const readiness = await inspect();
    expect(readiness.isAutoResumable).toBe(false);
    expect(readiness.uncertainSideEffectTaskIdentifiers).toContain("T-2");
    expect(readiness.blockedReasons.length).toBeGreaterThan(0);
  }, 60_000);

  it("blocked 任务 ⇒ 不可自动恢复（等待裁决，不自动放行）", async () => {
    await writeChain([buildNode("T-1", "blocked")]);
    const readiness = await inspect();
    expect(readiness.isAutoResumable).toBe(false);
    expect(readiness.blockedAwaitingDecisionTaskIdentifiers).toContain("T-1");
  }, 60_000);

  it("已产出但未回执（有 resultLocation 却不是 done）⇒ 不可自动恢复", async () => {
    await writeChain([buildNode("T-1", "pending", { resultLocation: "docs/out.md" })]);
    const readiness = await inspect();
    expect(readiness.isAutoResumable).toBe(false);
    expect(readiness.producedButUnacknowledgedTaskIdentifiers).toContain("T-1");
  }, 60_000);

  it("只有干净 pending ⇒ **可以**自动恢复（不误伤正常场景）", async () => {
    await writeChain([buildNode("T-1", "done"), buildNode("T-2", "pending")]);
    const readiness = await inspect();
    expect(readiness.isAutoResumable).toBe(true);
    expect(readiness.readyPendingTaskIdentifiers).toContain("T-2");
    expect(readiness.uncertainSideEffectTaskIdentifiers).toEqual([]);
  }, 60_000);
});
