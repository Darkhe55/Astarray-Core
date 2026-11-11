/**
 * REPAIR（T07E-04）：读取预算**真正生效**的端到端证据。
 *
 * 两条：
 * 1. 同一文件读两次 ⇒ 任务链累计来源仍为 1（去重）；
 * 2. 上限收紧到 1 时读第二个文件 ⇒ 被拒绝，且预算停在 1（不产生部分计数）。
 *
 * 计数由装配层注入的控制器记录（不是测试自己调出来的）。
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
let toolResultTexts: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chain-budget-e2e-"));
  workspace = path.join(stateDirectory, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.txt"), "hello budget\n", "utf8");
  await fs.writeFile(path.join(workspace, "b.txt"), "second file\n", "utf8");
  toolResultTexts = [];
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

/** 依次请求 filePathList 中的每个文件（每个文件只请求一次）。 */
function buildWorkerRuntime(filePathList: readonly string[]): AgentRuntime {
  let requestedCount = 0;
  return {
    async *run(runInput: AgentRunInput): AsyncIterable<AgentEvent> {
      const messages = (runInput as unknown as { toolResultMessages?: Array<{ content?: unknown }> })
        .toolResultMessages;
      if (Array.isArray(messages) && messages.length > 0) {
        toolResultTexts.push(messages.map((message) => String(message.content ?? "")).join("\n"));
        requestedCount += 1;
      }
      const nextFilePath = filePathList[requestedCount];
      if (nextFilePath === undefined) {
        yield { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" };
        return;
      }
      yield {
        kind: "toolCallRequested",
        callId: `call-${String(requestedCount)}`,
        toolName: "readFile",
        argumentsJson: JSON.stringify({ filePath: nextFilePath }),
      };
      yield { kind: "runFinished", agentId: "worker-1", reason: "tool-calls", detail: "读取文件" };
    },
  } as AgentRuntime;
}

async function createRuntime(input: {
  readonly filePathList: readonly string[];
  readonly maximumTaskChainCumulativeSourceFiles?: number;
}) {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    workspaceRootPath: workspace,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
    ...(input.maximumTaskChainCumulativeSourceFiles === undefined
      ? {}
      : { maximumTaskChainCumulativeSourceFiles: input.maximumTaskChainCumulativeSourceFiles }),
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
    workerRuntimeFactory: () => buildWorkerRuntime(input.filePathList),
  } as never);
}

async function waitForSnapshot(runtime: Awaited<ReturnType<typeof createRuntime>>, missionIdentifier: string) {
  const deadline = Date.now() + 40_000;
  let snapshot = await runtime.taskChainCumulativeBudget.getBudgetSnapshot(missionIdentifier);
  while (snapshot === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = await runtime.taskChainCumulativeBudget.getBudgetSnapshot(missionIdentifier);
  }
  return snapshot;
}

describe("任务链读取预算生效", () => {
  it("同一文件读两次 ⇒ 累计来源仍为 1", async () => {
    const runtime = await createRuntime({ filePathList: ["a.txt", "a.txt"] });
    try {
      const missionIdentifier = await runtime.controller.handleUserMessage("读取同一个文件", {
        projectIdentifier: "project-alpha",
      });
      const snapshot = await waitForSnapshot(runtime, missionIdentifier as unknown as string);
      expect(snapshot, "预算未被记录（说明注入未生效）").not.toBeNull();
      expect(snapshot?.cumulativeSourceFileCount).toBe(1);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);

  it("超过上限 ⇒ 第二个文件被拒绝，预算停在 1", async () => {
    const runtime = await createRuntime({
      filePathList: ["a.txt", "b.txt"],
      maximumTaskChainCumulativeSourceFiles: 1,
    });
    try {
      const missionIdentifier = await runtime.controller.handleUserMessage("依次读两个文件", {
        projectIdentifier: "project-alpha",
      });
      /** 等两个工具结果都回来（第二个应是拒绝结果）。 */
      const deadline = Date.now() + 40_000;
      while (toolResultTexts.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const snapshot = await runtime.taskChainCumulativeBudget.getBudgetSnapshot(
        missionIdentifier as unknown as string,
      );
      expect(snapshot?.cumulativeSourceFileCount).toBe(1);
      expect(toolResultTexts.join("\n")).toMatch(/上限|拒绝|permission-denied/u);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);
});
