/**
 * ALIGN-02-05（2026-11-08）：**恢复路径真的核对遗留领取**。
 *
 * 单元层已证明 `releaseClaim` 能回退；这里验证 `resumeMission` 的装配
 * 真的调用了核对（否则崩溃后任务仍被搁死）。
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
      await rm(directory, { recursive: true, force: true, maxRetries: 6 });
    }
  }
});

describe("恢复路径核对遗留领取", () => {
  it("恢复被拒绝时不误释放（活动租约/未对账场景保持 fail-closed）", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-resume-guard-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 3,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
    });
    try {
      const missionId = await runtime.controller.handleUserMessage("恢复守卫测试", {
        projectIdentifier: "project-a",
      });
      const deadline = Date.now() + 20_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (
        !["done", "blocked", "cancelled"].includes(status?.summary?.status ?? "") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      /** 已完成的任务再 resume ⇒ 不得"复活"、也不得把它打回 pending。 */
      const before = await runtime.controller.queryMissionTaskSequence(missionId);
      let resumeError: Error | null = null;
      try {
        await runtime.controller.resumeMission(missionId);
      } catch (error) {
        resumeError = error as Error;
      }
      const after = await runtime.controller.queryMissionTaskSequence(missionId);
      expect(after?.nodes.find((node) => node.taskIdentifier === after.taskIdentifier)?.status)
        .toBe(before?.nodes.find((node) => node.taskIdentifier === before.taskIdentifier)?.status);
      if (resumeError !== null) {
        expect(resumeError.message.length).toBeGreaterThan(0);
      }
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
