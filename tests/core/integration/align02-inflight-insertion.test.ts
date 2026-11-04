/**
 * ALIGN-02-06/05（2026-11-05）：在途任务导致推迟 + 取消后的终态回执。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import type { AgentRuntime } from "../../../packages/core/src/core/types.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

/** 永不主动完成、只在取消时收口的运行时（让任务保持 running）。 */
class HangingRuntime implements AgentRuntime {
  async *run(
    agentRunInput: Parameters<AgentRuntime["run"]>[0],
    cancellationSignal: AbortSignal,
  ): ReturnType<AgentRuntime["run"]> {
    await new Promise<void>((resolve) => {
      if (cancellationSignal.aborted) {
        resolve();
        return;
      }
      cancellationSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield {
      kind: "runFinished",
      agentId: agentRunInput.agentId,
      reason: "cancelled",
      detail: "测试运行时被取消",
    };
  }
}

describe("ALIGN-02 在途插入与取消", () => {
  it("有 running 任务时推迟；取消后序列任务进入终态", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-inflight-"));
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
      workerRuntimeFactory: () => new HangingRuntime(),
    });
    try {
      const missionId = await runtime.controller.handleUserMessage("在途插入", {
        projectIdentifier: "project-a",
      });
      const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
      let status = await runtime.controller.queryMissionStatus(missionId);
      const sequenceId = String(status?.summary?.taskSequenceIdentifier);
      const ownerAgentInstanceId = sequenceId.slice("sequence-".length);

      /** 等第一个任务真的进入 running（而不是只看 mission 状态）。 */
      const runningDeadline = Date.now() + 15_000;
      let isRunning = false;
      while (Date.now() < runningDeadline) {
        const mission = await runtime.controller.queryMissionStatus(missionId);
        isRunning =
          mission?.taskChain?.tasks.some((task) => task.status === "running") ?? false;
        if (isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(isRunning).toBe(true);

      const before = await store.readSequence(ownerAgentInstanceId, sequenceId);
      const outcome = await runtime.controller.requestRuntimeTaskInsertion({
        missionIdentifier: missionId,
        requestIdentifier: "inflight-request-1",
        expectedGroupRevision: before?.revision ?? 0,
        anchorTaskIdentifier: null,
        title: "在途插入",
        description: "有 running 任务",
        acceptanceCriteria: "完成",
        dependsOn: [],
      });
      expect(outcome.outcome, outcome.reason).toBe("deferred-to-sequence");

      await runtime.controller.cancelMission(missionId);
      const terminalDeadline = Date.now() + 20_000;
      let nodeStatus: string | null = null;
      while (Date.now() < terminalDeadline) {
        status = await runtime.controller.queryMissionStatus(missionId);
        const document = await store.readSequence(ownerAgentInstanceId, sequenceId);
        nodeStatus =
          document?.nodes.find(
            (candidate) => candidate.taskId === status?.summary?.originalTaskIdentifier,
          )?.status ?? null;
        if (
          (status?.summary?.status === "cancelled" ||
            status?.summary?.status === "blocked") &&
          nodeStatus !== "running"
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(["cancelled", "blocked"]).toContain(status?.summary?.status);
      expect(nodeStatus).not.toBe("running");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
