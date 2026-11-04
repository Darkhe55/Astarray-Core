/**
 * ALIGN-02-02（2026-11-05）：项目摘要真正进入规划提示词。
 *
 * 此前 `projectSummaryProvider` 既不在运行时选项里、也没传给控制器。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { ScriptedRuntime } from "../../../packages/core/src/runtime/scripted-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("ALIGN-02 项目摘要与规划", () => {
  it("规划启用时读取注入的项目摘要，产出 Agent 层节点", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-summary-"));
    directories.push(stateDirectory);
    const summaryProvider = vi.fn(async () => "示例项目：负责数据导入。");
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
      isModelTaskPlanningEnabled: true,
      workerRuntimeFactory: () =>
        new ScriptedRuntime([
          {
            type: "text",
            text: JSON.stringify({
              nodes: [
                {
                  id: "T-1",
                  description: "实现导入",
                  acceptanceCriteria: "导入测试通过",
                  dependsOn: [],
                  toolNames: [],
                },
              ],
            }),
          },
          { type: "finish", reason: "success", detail: "ok" },
        ]),
      projectSummaryProvider: summaryProvider,
    });
    try {
      const missionId = await runtime.controller.handleUserMessage("规划任务", {
        projectIdentifier: "project-a",
      });
      expect(summaryProvider).toHaveBeenCalledWith(
        expect.objectContaining({ projectIdentifier: "project-a" }),
      );
      const deadline = Date.now() + 20_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (status?.summary?.status !== "done" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      expect(status?.summary?.taskPlanningOutcome).toBe("model");
      expect(status?.taskChain?.tasks).toHaveLength(1);
      expect(status?.taskChain?.tasks[0]?.priorityTier).toBe(1);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
