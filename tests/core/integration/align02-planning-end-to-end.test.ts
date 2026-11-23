/**
 * F2（2026-11-24）：**ALIGN-02 规划路径端到端演练**（规划 → 依赖派发 → 完成）。
 *
 * 用注入的 ScriptedRuntime 区分两种角色：
 * - `planner:*` ⇒ 返回两节点候选稿（T-1 → T-2 依赖）；
 * - Worker ⇒ 返回成功文本。
 *
 * 断言：规划结果被采纳（`taskPlanningOutcome=model`）、依赖保留、按依赖顺序各派发一次、mission 收口 done。
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

describe("F2：ALIGN-02 规划路径端到端", () => {
  it("两节点候选稿被采纳 ⇒ 依赖保留、按序派发、mission done", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-e2e-"));
    directories.push(stateDirectory);

    /** 记录每次实际构造的 Worker（planner 也经同一工厂）。 */
    const startedAgentIds: string[] = [];
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
      workerRuntimeFactory: (agentInstanceId) => {
        startedAgentIds.push(agentInstanceId);
        if (agentInstanceId.startsWith("planner:")) {
          return new ScriptedRuntime([
            {
              type: "text",
              text: JSON.stringify({
                nodes: [
                  {
                    id: "T-1",
                    description: "准备数据",
                    acceptanceCriteria: "数据文件存在",
                    dependsOn: [],
                    toolNames: [],
                  },
                  {
                    id: "T-2",
                    description: "基于数据生成报告",
                    acceptanceCriteria: "报告已生成",
                    dependsOn: ["T-1"],
                    toolNames: [],
                  },
                ],
              }),
            },
            { type: "finish", reason: "success", detail: "ok" },
          ]);
        }
        return new ScriptedRuntime([
          { type: "text", text: `节点 ${agentInstanceId} 完成` },
          { type: "finish", reason: "success", detail: "ok" },
        ]);
      },
    });
    try {
      const missionId = await runtime.controller.handleUserMessage("两阶段任务");
      const deadline = Date.now() + 30_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (status?.summary?.status !== "done" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      expect(status?.summary?.status).toBe("done");
      expect(status?.summary?.taskPlanningOutcome).toBe("model");
      const tasks = status?.taskChain?.tasks ?? [];
      expect(tasks).toHaveLength(2);
      const first = tasks.find((task) => task.id === "T-1");
      const second = tasks.find((task) => task.id === "T-2");
      expect(first?.status).toBe("done");
      expect(second?.status).toBe("done");
      expect(second?.dependsOn).toEqual(["T-1"]);

      /** 规划器先构造；之后 T-1、T-2 各一次，且 T-1 早于 T-2。 */
      const plannerIndex = startedAgentIds.findIndex((id) => id.startsWith("planner:"));
      const firstIndex = startedAgentIds.findIndex((id) => id.includes(":T-1:"));
      const secondIndex = startedAgentIds.findIndex((id) => id.includes(":T-2:"));
      expect(plannerIndex).toBeGreaterThanOrEqual(0);
      expect(firstIndex).toBeGreaterThanOrEqual(0);
      expect(secondIndex).toBeGreaterThan(firstIndex);
      expect(startedAgentIds.filter((id) => id.includes(":T-1:"))).toHaveLength(1);
      expect(startedAgentIds.filter((id) => id.includes(":T-2:"))).toHaveLength(1);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
