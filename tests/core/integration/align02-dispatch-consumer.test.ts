/**
 * ALIGN-02-05（2026-11-05）：持续调度循环在生产里真的被调用。
 *
 * 此前 `SecondaryContinuousDispatchLoop.runRound` 没有任何生产调用方。
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

describe("ALIGN-02 派发消费者", () => {
  it("mission 启动时注册端口并跑一轮，终态时注销", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-dispatch-"));
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
      const loop = runtime.secondaryDispatchLoop;
      const registerSpy = vi.spyOn(loop, "registerMissionPorts");
      const unregisterSpy = vi.spyOn(loop, "unregisterMissionPorts");
      const runSpy = vi.spyOn(loop, "runRound").mockResolvedValue({
        dispatchedTaskIds: [],
        pausedCount: 0,
        queuedCount: 0,
        occupiedSlotsAtRoundStart: 0,
        skippedReasons: {},
        blockedReason: null,
        consecutiveNoProgressRoundCount: 0,
        recommendedWaitMilliseconds: 0,
      });

      const missionId = await runtime.controller.handleUserMessage("派发消费者", {
        projectIdentifier: "project-a",
      });
      expect(registerSpy).toHaveBeenCalledWith(
        missionId,
        expect.objectContaining({ dispatchChain: expect.any(Function) }),
      );
      expect(runSpy).toHaveBeenCalledWith(
        expect.objectContaining({ missionIdentifier: missionId }),
      );
      const roundInput = runSpy.mock.calls[0]?.[0] as {
        nodes: { priorityTier?: number }[];
      };
      /** ALIGN-02-03：旧单节点链没有优先级字段 ⇒ 按用户层 0 参与排序。 */
      expect(roundInput.nodes[0]?.priorityTier).toBe(0);

      const deadline = Date.now() + 20_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (status?.summary?.status !== "done" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      expect(status?.summary?.status).toBe("done");
      expect(unregisterSpy).toHaveBeenCalledWith(missionId);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
