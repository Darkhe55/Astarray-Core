/**
 * UI-ALIGN-01（2026-11-06）：只读权威任务序列查询（公开入口）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

async function createRuntime(stateDirectory: string) {
  return createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  });
}

describe("mission 任务序列只读查询", () => {
  it("返回节点/依赖/优先层/revision 与就绪集合；完成节点不进入 ready", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-seq-query-"));
    directories.push(stateDirectory);
    const runtime = await createRuntime(stateDirectory);
    try {
      const missionId = await runtime.controller.handleUserMessage("序列查询", {
        projectIdentifier: "project-a",
      });
      const deadline = Date.now() + 15_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (status?.summary?.status !== "done" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      const sequence = await runtime.controller.queryMissionTaskSequence(missionId);
      expect(sequence).not.toBeNull();
      expect(sequence?.missionIdentifier).toBe(missionId);
      expect(sequence?.sequenceIdentifier).toMatch(/^sequence-/);
      expect(sequence?.revision).toBeGreaterThan(0);
      expect(sequence?.nodes).toHaveLength(1);
      expect(sequence?.nodes[0]?.taskIdentifier).toBe(sequence?.taskIdentifier);
      expect(sequence?.nodes[0]?.status).toBe("done");
      expect(sequence?.nodes[0]?.priorityTier).toBe(0);
      expect(sequence?.readyTaskIdentifiers).toEqual([]);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("无映射/未知 mission ⇒ null（不猜序列）", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-seq-query2-"));
    directories.push(stateDirectory);
    const runtime = await createRuntime(stateDirectory);
    try {
      expect(await runtime.controller.queryMissionTaskSequence("mission-missing")).toBeNull();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
