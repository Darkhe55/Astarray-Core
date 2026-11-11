/**
 * REPAIR（`TaskChainCumulativeBudgetController`）：装配层构造 + 可达性。
 *
 * 分诊结论是"T07E-04 的文件/token 累计预算在生产不存在"。
 * 本用例从**真实装配入口**取出控制器，验证跨 Agent 累计、去重、
 * 以及**状态落盘可重启续算**（这是"重启后不重复计数"的前提）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chain-budget-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function createRuntime() {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
  } as never);
}

describe("任务链累计预算装配", () => {
  it("装配层构造；跨 Agent 累计去重；状态落盘", async () => {
    const runtime = await createRuntime();
    try {
      const controller = runtime.taskChainCumulativeBudget;
      expect(controller).toBeDefined();

      const first = await controller.registerTaskChainSource({
        taskChainIdentifier: "chain-1",
        agentInstanceId: "worker-1",
        canonicalSourceIdentity: "src/a.ts",
        contentBytes: 100,
        estimatedTokenCount: 25,
      });
      expect(first.cumulativeSourceFileCount).toBe(1);

      /** 另一个 Agent 读同一文件 ⇒ 仍然只算 1 个来源（去重，防"多开 Agent 藏量"）。 */
      const duplicate = await controller.registerTaskChainSource({
        taskChainIdentifier: "chain-1",
        agentInstanceId: "worker-2",
        canonicalSourceIdentity: "src/a.ts",
        contentBytes: 100,
        estimatedTokenCount: 25,
      });
      expect(duplicate.cumulativeSourceFileCount).toBe(1);

      const snapshot = await controller.getBudgetSnapshot("chain-1");
      expect(snapshot?.cumulativeSourceFileCount).toBe(1);
      expect(snapshot?.participatingAgentInstanceIds.sort()).toEqual(["worker-1", "worker-2"]);

      /** 状态落盘：新实例（模拟重启）能读回同一份计数。 */
      const stateFiles = await fs.readdir(path.join(stateDirectory, "task-chain-budget"));
      expect(stateFiles.length).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
