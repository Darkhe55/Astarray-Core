/**
 * 任务简报（2026-11-17）：**模型实际收到的必需内容**。
 *
 * 背景：T09A-R1-01 验收的是四段装配，不含任务正文/验收要求/依赖摘要；
 * 本用例捕获**真实请求载荷**，断言这些内容确实到了模型面前——
 * 而不是只断言"provider 被调用过"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkerAgent } from "../../../packages/core/src/orchestration/worker-agent.js";
import { buildTaskBriefing } from "../../../packages/core/src/orchestration/task-briefing.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "task-briefing-"));
  void baseDirectory;
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildWorker(input: {
  capturedPrompts: string[];
  acceptanceCriteria?: string | null;
  dependsOn?: string[];
  dependencyBriefings?: Array<{
    taskIdentifier: string;
    description: string | null;
    status: string;
  }>;
  toolNames?: string[];
  maximumCharacterCount?: number;
  sourceSequenceTaskIdentifier?: string;
}) {
  const workerOptions: Record<string, unknown> = {
    agentInstanceId: "worker-1",
    missionId: "mission-1",
    task: {
      id: "T-001",
      description: "实现导出功能",
      dependsOn: input.dependsOn ?? [],
      taskType: "data",
      toolNames: input.toolNames ?? ["writeFile", "readFile"],
      status: "running",
      assignedAgentId: "worker-1",
      resultLocation: null,
      ...(input.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: input.acceptanceCriteria }),
      ...(input.sourceSequenceTaskIdentifier === undefined
        ? {}
        : { sourceSequenceTaskIdentifier: input.sourceSequenceTaskIdentifier }),
    },
    runtime: {
      async *run(runInput: { systemPrompt: string }) {
        input.capturedPrompts.push(runInput.systemPrompt);
        yield { kind: "textDelta", deltaText: "ok" };
      },
    },
    toolPort: { execute: async () => ({ kind: "success", callId: "c-1", outputText: "" }) },
    failureCounter: { recordFailure: () => false, recordSuccess: () => {} },
    feedbackTransport: { setAgentStatus: () => {}, enqueue: async () => 1 },
    maxLoopIterations: 1,
    buildPermissionExplanation: () => "why",
    ...(input.dependencyBriefings === undefined
      ? {}
      : { dependencyBriefings: input.dependencyBriefings }),
    ...(input.maximumCharacterCount === undefined
      ? {}
      : { taskBriefingMaximumCharacterCount: input.maximumCharacterCount }),
  };
  return new WorkerAgent(workerOptions as never);
}

describe("任务简报：模型真的收到必需内容", () => {
  it("① 请求载荷包含任务正文、验收要求、依赖摘要与工具清单", async () => {
    const capturedPrompts: string[] = [];
    const worker = buildWorker({
      capturedPrompts,
      acceptanceCriteria: "导出 CSV 且列顺序固定",
      dependsOn: ["T-000"],
      dependencyBriefings: [
        { taskIdentifier: "T-000", description: "搭好数据模型", status: "done" },
      ],
    });
    await worker.run();

    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("[任务简报]");
    expect(prompt).toContain("实现导出功能");
    expect(prompt).toContain("导出 CSV 且列顺序固定");
    expect(prompt).toContain("搭好数据模型");
    expect(prompt).toContain("writeFile, readFile");
    /** 不得把简报说成系统指令。 */
    expect(prompt).toContain("不是系统指令");
  });

  it("② 缺验收要求 ⇒ 写「未声明」，不伪造", async () => {
    const capturedPrompts: string[] = [];
    const worker = buildWorker({ capturedPrompts });
    await worker.run();
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("验收要求：未声明");
  });

  it("③ 声明了依赖但拿不到描述 ⇒ 如实标「无可用描述」", async () => {
    const capturedPrompts: string[] = [];
    const worker = buildWorker({ capturedPrompts, dependsOn: ["T-404"] });
    await worker.run();
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("T-404");
    expect(prompt).toContain("无可用描述");
  });

  it("④ 未声明依赖 ⇒ 明写「依赖任务：无」（不是空白）", async () => {
    const capturedPrompts: string[] = [];
    const worker = buildWorker({ capturedPrompts });
    await worker.run();
    expect(capturedPrompts[0] ?? "").toContain("依赖任务：无");
  });

  it("⑤ 超预算 ⇒ 阻塞（不截断、不继续调用模型）", async () => {
    const capturedPrompts: string[] = [];
    const worker = buildWorker({ capturedPrompts, maximumCharacterCount: 10 });
    await expect(worker.run()).rejects.toMatchObject({
      errorCode: "task-briefing-budget-exceeded",
    });
    expect(capturedPrompts).toHaveLength(0);
  });
});

describe("任务简报文本（纯函数）", () => {
  it("⑥ 预算内返回 fits，且 undeclaredFields 记录缺失项", () => {
    const briefing = buildTaskBriefing({
      task: {
        id: "T-1",
        description: "做事",
        taskType: "data",
        toolNames: [],
        acceptanceCriteria: null,
        dependsOn: [],
      },
      dependencies: [],
      maximumCharacterCount: 4_000,
    });
    expect(briefing.budget.kind).toBe("fits");
    expect(briefing.undeclaredFields).toEqual(["acceptanceCriteria", "toolNames"]);
  });
});

describe("WIRING-04-04：简报显示任务来源", () => {
  it("⑦ 声明来源 ⇒ 简报写明来源任务", async () => {
    const capturedPrompts: string[] = [];
    const worker = buildWorker({
      capturedPrompts,
      sourceSequenceTaskIdentifier: "task-mission-1",
    });
    await worker.run();
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("来源任务：task-mission-1");
    expect(prompt).toContain("用户任务序列中的原始任务");
  }, 30_000);

  it("⑧ 未声明来源 ⇒ 明确写「未声明」（不伪造）", async () => {
    const capturedPrompts: string[] = [];
    const worker = buildWorker({ capturedPrompts });
    await worker.run();
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("来源任务：未声明");
  }, 30_000);
});
