/**
 * ALIGN-04-03（2026-11-10）：**恢复拒绝时的对账诊断**。
 *
 * 验证 `resumeMission` 在"有已产出未回执任务"时：
 *  ① 拒绝恢复（`mission-locked`）；
 *  ② 输出逐个任务的对账结论；
 *  ③ **项目根不可解析时不附产物校验**（不猜、也不下"已产出"结论）。
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
const MISSION_ID = "mission-reconcile-diag";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-recon-diag-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildNode(
  id: string,
  status: TaskDependencyNode["status"],
  resultLocation: string | null = null,
): TaskDependencyNode {
  return {
    id,
    description: "任务 " + id,
    dependsOn: [],
    taskType: "data",
    toolNames: ["read"],
    assignedAgentId: null,
    status,
    resultLocation,
  };
}

async function writeChain(nodes: TaskDependencyNode[]): Promise<void> {
  const store = new TaskStore({ baseDirectory: stateDirectory });
  const chain: TaskChainDocument = {
    schemaVersion: 1,
    missionId: MISSION_ID,
    revision: 1,
    updatedAtIso: "2026-11-10T00:00:00.000Z",
    tasks: nodes,
  };
  await store.writeTaskChain(chain);
}

async function attemptResume(): Promise<{ readonly outputLines: string[]; readonly error: Error | null }> {
  const outputLines: string[] = [];
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: (_missionId: string | null, text: string) => {
      outputLines.push(text);
    },
  });
  try {
    const error = await runtime.controller
      .resumeMission(MISSION_ID)
      .then(() => null)
      .catch((caught: unknown) => caught as Error);
    return { outputLines, error };
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("ALIGN-04-03 恢复拒绝的对账诊断", () => {
  it("有已产出未回执任务 ⇒ 拒绝恢复，并输出该任务的对账结论", async () => {
    await writeChain([buildNode("T-1", "pending", "docs/out.md")]);
    const { outputLines, error } = await attemptResume();
    expect(error).not.toBeNull();
    const reconciliationLines = outputLines.filter((line) => line.includes("[对账]"));
    expect(reconciliationLines.length).toBeGreaterThan(0);
    expect(reconciliationLines.join("\n")).toContain("requires-output-acknowledgement");
  }, 60_000);

  it("崩溃 running ⇒ 拒绝恢复，结论是「需核对副作用」", async () => {
    await writeChain([buildNode("T-1", "running")]);
    const { outputLines, error } = await attemptResume();
    expect(error).not.toBeNull();
    const joined = outputLines.join("\n");
    expect(joined).toContain("requires-side-effect-review");
  }, 60_000);

  it("**项目根不可解析** ⇒ 不附产物校验（不猜、也不下「已产出」结论）", async () => {
    await writeChain([buildNode("T-1", "pending", "docs/out.md")]);
    const { outputLines } = await attemptResume();
    /** 合成 mission 没有登记项目映射 ⇒ 根不可解析 ⇒ 必须**跳过**校验。 */
    expect(outputLines.join("\n")).not.toContain("产物校验");
  }, 60_000);

  it("干净 pending ⇒ 不产生对账拒绝（不误伤正常恢复）", async () => {
    await writeChain([buildNode("T-1", "pending")]);
    const { outputLines } = await attemptResume();
    expect(outputLines.filter((line) => line.includes("[对账]"))).toEqual([]);
  }, 60_000);
});
