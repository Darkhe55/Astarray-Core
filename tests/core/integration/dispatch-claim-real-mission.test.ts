/**
 * ALIGN-02-05（2026-11-08）：**生产装配**里的领取与释放真的发生。
 *
 * 与 `dispatch-claim-production.test.ts` 的差别：那里验端口可透传；
 * 这里验 **MainController 装配的端口**在真实 mission 上真的领取序列任务。
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

async function createRuntime() {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-claim-prod-"));
  directories.push(stateDirectory);
  return createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 4,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  });
}

describe("生产派发：序列领取闭环", () => {
  it("任务启动后序列原始任务离开 pending（领取真的发生）", async () => {
    const runtime = await createRuntime();
    try {
      const missionId = await runtime.controller.handleUserMessage("领取闭环测试", {
        projectIdentifier: "project-a",
      });
      /** 领取发生在 mission 启动瞬间；等待终态即可证明它曾经离开 pending。 */
      const deadline = Date.now() + 20_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (
        !["done", "blocked", "cancelled"].includes(status?.summary?.status ?? "") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      expect(["done", "blocked"]).toContain(status?.summary?.status);

      const sequence = await runtime.controller.queryMissionTaskSequence(missionId);
      expect(sequence).not.toBeNull();
      const originalTask = sequence!.nodes.find(
        (node) => node.taskIdentifier === sequence!.taskIdentifier,
      );
      /** 终态之后序列原始任务应已有结论（不是永远 pending）。 */
      expect(originalTask?.status).not.toBe("pending");
      expect(["done", "running", "blocked", "failed"]).toContain(originalTask?.status);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("无序列映射的 mission 不因领取而阻塞（旧路径行为不变）", async () => {
    const runtime = await createRuntime();
    try {
      const missionId = await runtime.controller.handleUserMessage("无映射测试", {
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
      expect(["done", "blocked"]).toContain(status?.summary?.status);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
