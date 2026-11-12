/**
 * 模型任务分解规划器（此前 `tests/` 零引用）；本文件**不调用任何真实模型**。
 *
 * 三条纪律：预算超时即放弃 / 拿不到 JSON 就失败（不编造）/ 生产器默认不启用。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TASK_PLANNING_BUDGET_MILLISECONDS,
  buildPlannerTaskPlaceholder,
  createModelBackedTaskDecompositionProvider,
  extractJsonObject,
} from "../../../packages/core/src/orchestration/model-task-decomposition-planner.js";

interface CapturedRun {
  systemPrompt: string;
  userPrompt: string;
  maxLoopIterations: number;
}

function buildFakeRuntime(options: {
  textChunks?: string[];
  throwError?: Error;
  delayMilliseconds?: number;
  captured?: CapturedRun[];
}) {
  return {
    run: (parameters: {
      systemPrompt: string;
      userPrompt: string;
      maxLoopIterations: number;
    }) => {
      options.captured?.push({
        systemPrompt: parameters.systemPrompt,
        userPrompt: parameters.userPrompt,
        maxLoopIterations: parameters.maxLoopIterations,
      });
      return (async function* () {
        if (options.delayMilliseconds !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMilliseconds));
        }
        if (options.throwError !== undefined) {
          throw options.throwError;
        }
        for (const textChunk of options.textChunks ?? []) {
          yield { kind: "textDelta", deltaText: textChunk };
        }
      })();
    },
  } as never;
}

describe("JSON 抽取", () => {
  it("① 空文本 ⇒ 失败（不编造分解）", () => {
    expect(() => extractJsonObject("   ")).toThrow(/没有返回任何文本/u);
  });

  it("② 没有 JSON 对象 ⇒ 失败（拒绝猜测）", () => {
    expect(() => extractJsonObject("我认为应该拆成三个任务。")).toThrow(/没有 JSON 对象/u);
  });

  it("③ JSON 无法解析 ⇒ 失败（拒绝半成品）", () => {
    /** 有花括号但内容非法 ⇒ 走解析失败分支（与"没有 JSON 对象"区分）。 */
    expect(() => extractJsonObject('{"nodes": [}')) .toThrow(/无法解析/u);
  });

  it("④ 前后有废话 ⇒ 抽出对象", () => {
    expect(extractJsonObject('好的：{"nodes":[{"id":"T-01"}]} 以上。')).toEqual({
      nodes: [{ id: "T-01" }],
    });
  });
});

describe("模型候选稿生产器", () => {
  it("⑤ 正常 ⇒ 返回解析结果；提示词含任务原文、工具清单与「无摘要不臆测」", async () => {
    const captured: CapturedRun[] = [];
    const provider = createModelBackedTaskDecompositionProvider({
      runtimeFactory: () =>
        buildFakeRuntime({ textChunks: ['{"nodes":[{"id":"T-01"}]}'], captured }),
      availableToolNames: [],
    });
    const draft = await provider({
      missionIdentifier: "mission-1",
      instructionText: "把文档补完",
      projectSummary: null,
    });
    expect(draft).toEqual({ nodes: [{ id: "T-01" }] });
    expect(captured[0]?.userPrompt).toContain("把文档补完");
    expect(captured[0]?.userPrompt).toContain("不要臆测项目内容");
    expect(captured[0]?.systemPrompt).toContain("（无）");
    expect(captured[0]?.maxLoopIterations).toBe(1);
  });

  it("⑥ 模型没有输出 ⇒ 失败（不编造）", async () => {
    const provider = createModelBackedTaskDecompositionProvider({
      runtimeFactory: () => buildFakeRuntime({ textChunks: [] }),
    });
    await expect(
      provider({ missionIdentifier: "mission-1", instructionText: "做事", projectSummary: "摘要" }),
    ).rejects.toThrow(/没有返回任何文本/u);
  });

  it("⑦ 超过预算 ⇒ 放弃并行说明「不编造分解」", async () => {
    const provider = createModelBackedTaskDecompositionProvider({
      runtimeFactory: () =>
        buildFakeRuntime({ delayMilliseconds: 30, throwError: new Error("aborted") }),
      budgetMilliseconds: 1,
    });
    await expect(
      provider({ missionIdentifier: "mission-1", instructionText: "做事", projectSummary: null }),
    ).rejects.toThrow(/预算/u);
  });

  it("⑧ 占位节点不进入任务链：id=planner、无工具、未分配、pending", () => {
    const placeholder = buildPlannerTaskPlaceholder();
    expect(placeholder.id).toBe("planner");
    expect(placeholder.toolNames).toEqual([]);
    expect(placeholder.assignedAgentId).toBeNull();
    expect(placeholder.status).toBe("pending");
    expect(placeholder.dependsOn).toEqual([]);
    expect(DEFAULT_TASK_PLANNING_BUDGET_MILLISECONDS).toBe(120_000);
  });
});
