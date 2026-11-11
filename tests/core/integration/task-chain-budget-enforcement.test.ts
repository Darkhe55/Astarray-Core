/**
 * REPAIR（T07E-04）：读取预算**真正生效**的端到端证据。
 *
 * 断言：脚本化 worker 读同一文件两次 ⇒ 任务链累计来源仍然是 **1**（去重）；
 * 且这份计数由装配层注入的控制器记录（不是测试自己调出来的）。
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
let workspace: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chain-budget-e2e-"));
  workspace = path.join(stateDirectory, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.txt"), "hello budget\n", "utf8");
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildWorkerRuntime(): AgentRuntime {
  let callIndex = 0;
  return {
    async *run(runInput: AgentRunInput): AsyncIterable<AgentEvent> {
      const messages = (runInput as unknown as { toolResultMessages?: unknown[] }).toolResultMessages;
      if (Array.isArray(messages) && messages.length > 0) {
        callIndex += 1;
        if (callIndex >= 2) {
          yield { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" };
          return;
        }
      }
      yield {
        kind: "toolCallRequested",
        callId: `call-${String(callIndex)}`,
        toolName: "readFile",
        argumentsJson: JSON.stringify({ filePath: "a.txt" }),
      };
      yield { kind: "runFinished", agentId: "worker-1", reason: "tool-calls", detail: "读取文件" };
    },
  } as AgentRuntime;
}

describe("任务链读取预算生效", () => {
  it("同一文件读两次 ⇒ 累计来源仍为 1", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      workspaceRootPath: workspace,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 6,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
      isModelTaskPlanningEnabled: true,
      taskDecompositionDraftProvider: async () =>
        JSON.stringify({
          nodes: [
            {
              id: "T-001",
              description: "读取预算用例",
              dependsOn: [],
              acceptanceCriteria: "读取被记录",
              toolNames: ["readFile"],
            },
          ],
        }),
      workerRuntimeFactory: () => buildWorkerRuntime(),
    } as never);

    try {
      const missionIdentifier = await runtime.controller.handleUserMessage("读取同一个文件", {
        projectIdentifier: "project-alpha",
      });
      const deadline = Date.now() + 40_000;
      let snapshot = await runtime.taskChainCumulativeBudget.getBudgetSnapshot(
        missionIdentifier as unknown as string,
      );
      while (snapshot === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        snapshot = await runtime.taskChainCumulativeBudget.getBudgetSnapshot(
          missionIdentifier as unknown as string,
        );
      }
      expect(snapshot, "预算未被记录（说明注入未生效）").not.toBeNull();
      expect(snapshot?.cumulativeSourceFileCount).toBe(1);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);
});
