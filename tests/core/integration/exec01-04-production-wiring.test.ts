/**
 * EXEC-01-04（2026-11-09）：**生产接线**验证。
 *
 * 两条证据分开断言，避免把"权限询问"当成"后端缺失"：
 * 1. assist：调用 `processExecution` 会走到**权限询问** ⇒ 证明描述符已注册、
 *    能力已映射、任务工具子集已分配、策略链已放行到裁决层；
 * 2. devolve：能力默认 allow ⇒ 真正执行 ⇒ 因为还没有随产品交付的沙箱后端，
 *    如实返回"未装配沙箱执行后端"，**不**降级到宿主进程执行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRunInput, AgentRuntime } from "../../../packages/core/src/core/types.js";

let stateDirectory: string;
let streamedTexts: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-exec-wiring-"));
  streamedTexts = [];
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 6 });
});

function buildScriptedRuntime(input: {
  readonly argumentsJson: string;
  readonly recordedInputs: AgentRunInput[];
}): AgentRuntime {
  return {
    async *run(runInput: AgentRunInput): AsyncIterable<AgentEvent> {
      input.recordedInputs.push(runInput);
      if (input.recordedInputs.length === 1) {
        yield {
          kind: "toolCallRequested",
          callId: "call-process-execution",
          toolName: "processExecution",
          argumentsJson: input.argumentsJson,
        };
        yield {
          kind: "runFinished",
          agentId: "worker-1",
          reason: "tool-calls",
          detail: "需要执行进程",
        };
        return;
      }
      yield {
        kind: "runFinished",
        agentId: "worker-1",
        reason: "success",
        detail: "完成",
      };
    },
  } as AgentRuntime;
}

async function runMissionWithProcessExecution(input: {
  readonly mode: "assist" | "devolve";
}): Promise<{ readonly streamedJoined: string; readonly inputTranscript: string }> {
  const recordedInputs: AgentRunInput[] = [];
  const runtime = await createApplicationRuntime({
    mode: input.mode,
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 4,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: (_missionIdentifier, text) => {
      streamedTexts.push(text);
    },
    workerRuntimeFactory: () =>
      buildScriptedRuntime({
        argumentsJson: JSON.stringify({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: ["--test"],
          workingDirectory: "src",
        }),
        recordedInputs,
      }),
  });
  try {
    const missionIdentifier = await runtime.controller.handleUserMessage(
      "执行测试脚本",
      { projectIdentifier: "project-a" },
    );
    /**
     * 等"出现可判定的观测"：要么第二轮已开始（工具结果已回填），
     * 要么权限询问文本已经流出，要么 mission 已终态。
     *
     * 不能只等第二轮：权限询问会**挂住**任务，不会产生第二轮；
     * 而询问文本是异步流出的，只等终态会读到空串（实测门禁翻红过）。
     */
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (recordedInputs.length >= 2) break;
      if (streamedTexts.join("\n").includes("processExecution")) break;
      const status = (await runtime.controller.queryMissionStatus(missionIdentifier))
        ?.summary?.status ?? "";
      if (["done", "blocked", "cancelled", "failed"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      streamedJoined: streamedTexts.join("\n"),
      /** 第二轮输入里应当带上一轮的工具结果（工具错误也走这条回填）。 */
      inputTranscript: JSON.stringify(recordedInputs),
    };
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("EXEC-01-04 生产接线", () => {
  it("assist：调用 processExecution 走到权限询问（证明工具真的可达）", async () => {
    const { streamedJoined, inputTranscript } = await runMissionWithProcessExecution({
      mode: "assist",
    });
    /**
     * 询问文本可能经流式输出，也可能只出现在**工具结果回填**里（`permission-ask-pending`）；
     * 只断言其中一条通道会在满载时翻红（实测踩到两次）。这里对两者取并集。
     */
    const observed = streamedJoined + "\n" + inputTranscript;
    expect(observed).not.toContain("tool-not-found");
    expect(observed).toContain("processExecution");
    expect(observed).toMatch(/permission-ask-pending|需要权限调用 processExecution/u);
  }, 90_000);

  it("devolve：放行后如实报未装配沙箱后端，不降级宿主执行", async () => {
    const { streamedJoined, inputTranscript } = await runMissionWithProcessExecution({
      mode: "devolve",
    });
    /** 工具结果回填到第二轮输入：错误文本必须说明是**后端缺失**。 */
    const observed = streamedJoined + "\n" + inputTranscript;
    expect(observed).not.toContain("tool-not-found");
    expect(observed).toContain("processExecution");
    expect(observed).toContain("未装配沙箱执行后端");
  }, 90_000);

  it("主 Agent 工具投影不含 processExecution（执行工具只给次级执行 Agent）", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 2,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
    });
    try {
      const projection = runtime.controller.getMainAgentToolProjection();
      const names = projection.map((entry) =>
        typeof entry === "string" ? entry : String((entry as { name?: string }).name),
      );
      expect(names).not.toContain("processExecution");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
