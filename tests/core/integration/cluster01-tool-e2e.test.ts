/**
 * CLUSTER-01 §5：**端到端**工具调用（脚本化 worker 经策略包装调用）。
 *
 * 本用例只证明一件事：调用被**路由到了聚类工具**（而不是"未知工具"），
 * 且在**未获写授权**时不产生索引（默认 `diagnostic.clusters.build = ask`）。
 *
 * 刻意不在这里构造"批准后落盘"——那需要改权限裁决，属另一条用例。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRunInput, AgentRuntime } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;
const toolResultTexts: string[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-e2e-"));
  toolResultTexts.length = 0;
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildWorkerRuntime(): AgentRuntime {
  return {
    async *run(runInput: AgentRunInput): AsyncIterable<AgentEvent> {
      /** 第二轮输入带 toolResultMessages ⇒ 说明工具调用已发生并拿到了结果。 */
      const messages = (runInput as unknown as { toolResultMessages?: Array<{ role?: string; content?: unknown }> })
        .toolResultMessages;
      if (Array.isArray(messages) && messages.length > 0) {
        toolResultTexts.push(messages.map((message) => String(message.content ?? "")).join("\n"));
        yield { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" };
        return;
      }
      yield {
        kind: "toolCallRequested",
        callId: "call-cluster",
        toolName: "diagnosticClusters",
        argumentsJson: JSON.stringify({ action: "build" }),
      };
      yield { kind: "runFinished", agentId: "worker-1", reason: "tool-calls", detail: "调用聚类工具" };
    },
  } as AgentRuntime;
}

describe("CLUSTER-01 端到端调用", () => {
  it("**获授权后** ⇒ build 真的执行并落盘", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 4,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
      isDiagnosticClusteringEnabled: true,
      isModelTaskPlanningEnabled: true,
      taskDecompositionDraftProvider: async () =>
        JSON.stringify({
          nodes: [
            {
              id: "T-001",
              description: "聚类用例",
              dependsOn: [],
              acceptanceCriteria: "工具结果可观测",
              toolNames: ["diagnosticClusters"],
            },
          ],
        }),
      workerRuntimeFactory: () => buildWorkerRuntime(),
    } as never);

    try {
      /** 参数级授权：批准"这一次 build 调用"（与 audit01 对 proposeGoal 的做法一致）。 */
      await runtime.controller.grantSessionAuthorization(
        "diagnosticClusters",
        JSON.stringify({ action: "build" }),
        Math.floor(Date.now() / 1000),
      );
      await runtime.controller.handleUserMessage("跑一次已授权的聚类调用", {
        projectIdentifier: "project-alpha",
      });
      const deadline = Date.now() + 30_000;
      const indexDirectory = path.join(stateDirectory, "analysis", "diagnostic-clusters");
      let hasIndex = false;
      while (!hasIndex && Date.now() < deadline) {
        hasIndex = await fs.stat(indexDirectory).then(() => true).catch(() => false);
        if (!hasIndex) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(hasIndex, `工具结果：${toolResultTexts.join(" | ").slice(0, 300)}`).toBe(true);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);

  it("脚本化 worker 调用 ⇒ 被路由到聚类工具，且未获写授权时不落盘", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 4,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
      isDiagnosticClusteringEnabled: true,
      isModelTaskPlanningEnabled: true,
      /** 让任务子集恰好包含该工具，否则调用在"未分配"层就被挡掉，测不到路由。 */
      taskDecompositionDraftProvider: async () =>
        JSON.stringify({
          nodes: [
            {
              id: "T-001",
              description: "聚类用例",
              dependsOn: [],
              acceptanceCriteria: "工具结果可观测",
              toolNames: ["diagnosticClusters"],
            },
          ],
        }),
      workerRuntimeFactory: () => buildWorkerRuntime(),
    } as never);

    try {
      await runtime.controller.handleUserMessage("跑一次聚类调用", { projectIdentifier: "project-alpha" });
      const deadline = Date.now() + 30_000;
      while (toolResultTexts.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const joined = toolResultTexts.join("\n");
      /** 路由证据：不是"未知工具"，而是权限/询问类结果。 */
      expect(joined).toMatch(/权限|询问|ask|denied/u);
      expect(joined).not.toMatch(/未知工具|unknown tool/iu);
      /** 未获写授权 ⇒ 索引不应落盘。 */
      await expect(fs.stat(path.join(stateDirectory, "analysis"))).rejects.toThrow();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);
});
