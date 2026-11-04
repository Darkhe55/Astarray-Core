/**
 * ALIGN-02-05（2026-11-05）：mission 终态回执写回权威序列。
 *
 * 此前 mission 完成后，权威序列里的原始用户任务永远停在 pending（两套记账）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("ALIGN-02 终态回执同步", () => {
  it("mission 完成后，权威序列的原始任务变为 done", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-sync-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
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
    try {
      const missionId = await runtime.controller.handleUserMessage("同步状态", {
        projectIdentifier: "project-a",
      });
      const deadline = Date.now() + 20_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (status?.summary?.status !== "done" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      expect(status?.summary?.status).toBe("done");

      const summary = status?.summary;
      expect(summary).not.toBeNull();
      const sequenceId = summary?.taskSequenceIdentifier ?? null;
      const taskId = summary?.originalTaskIdentifier ?? null;
      expect(sequenceId).toMatch(/^sequence-/);
      expect(typeof taskId).toBe("string");
      const ownerAgentInstanceId = String(sequenceId).slice("sequence-".length);
      /** 终态写入与序列同步是先后两步：轮询到同步完成（有界）。 */
      const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
      const syncDeadline = Date.now() + 10_000;
      let nodeStatus: string | null = null;
      while (Date.now() < syncDeadline) {
        const document = await store.readSequence(
          ownerAgentInstanceId,
          String(sequenceId),
        );
        nodeStatus =
          document?.nodes.find((candidate) => candidate.taskId === taskId)?.status ??
          null;
        if (nodeStatus === "done") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(nodeStatus).toBe("done");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});

  it("mission 运行期间，序列里的原始任务为 running", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-running-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      /** 0 并发：mission 保持 running，便于观察序列状态。 */
      concurrency: 0,
      failureThreshold: 1,
      maxLoopIterations: 8,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
    });
    try {
      const missionId = await runtime.controller.handleUserMessage("运行状态", {
        projectIdentifier: "project-a",
      });
      const status = await runtime.controller.queryMissionStatus(missionId);
      const sequenceId = String(status?.summary?.taskSequenceIdentifier);
      const taskId = String(status?.summary?.originalTaskIdentifier);
      const ownerAgentInstanceId = sequenceId.slice("sequence-".length);
      const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
      const deadline = Date.now() + 10_000;
      let nodeStatus: string | null = null;
      while (Date.now() < deadline) {
        const document = await store.readSequence(ownerAgentInstanceId, sequenceId);
        nodeStatus =
          document?.nodes.find((candidate) => candidate.taskId === taskId)?.status ??
          null;
        if (nodeStatus === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(nodeStatus).toBe("running");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
