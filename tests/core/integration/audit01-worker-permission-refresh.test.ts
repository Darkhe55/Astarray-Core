/**
 * AUDIT-REPAIR-01 / 用户裁决（2026-11-09）：**worker 的工具执行必须读取当前有效权限**。
 *
 * 真实缺陷：worker 的工具端口在任务派发时构造一次，权限组引用被**固定**在构造时；
 * 之后 `switchPermissionProfile` 或项目/会话覆盖变化都不会影响已在运行的 worker
 * （实测：切到 deny 组后 worker 仍能调用工具）。
 *
 * 本文件是**应用装配级**反例：不是验证"配置已保存"，而是验证
 * "同一 worker 端口上，收紧之前的调用成功、收紧之后的调用被拒绝"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRunInput, AgentRuntime } from "../../../packages/core/src/core/types.js";

/** RELIABILITY-01：本文件会跑真实装配的任务 ⇒ 显式预算。 */
vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;
/** 独立工作区（与状态目录分开：避免 `note.md` 落进受控存储范围）。 */
let workspaceDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-worker-perm-"));
  workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-worker-ws-"));
  await fs.writeFile(path.join(workspaceDirectory, "note.md"), "正文", "utf8");
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
  await fs.rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 10 });
});

interface ToolResultMessage {
  readonly role?: string;
  readonly content?: unknown;
}

function extractToolResultTexts(runInput: AgentRunInput): string[] {
  const messages = (runInput as unknown as { toolResultMessages?: ToolResultMessage[] })
    .toolResultMessages;
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""));
}

/**
 * 三轮 worker：
 * ① 调 `readFile`；
 * ② 收到结果后**在运行期间收紧权限**，再调 `readFile`；
 * ③ 收尾。
 */
function buildSwitchingRuntime(input: {
  readonly tighten: () => Promise<void>;
  readonly recordedInputs: AgentRunInput[];
}): AgentRuntime {
  return {
    async *run(runInput: AgentRunInput): AsyncIterable<AgentEvent> {
      input.recordedInputs.push(runInput);
      if (input.recordedInputs.length === 1) {
        yield {
          kind: "toolCallRequested",
          callId: "call-1",
          toolName: "readFile",
          argumentsJson: JSON.stringify({ filePath: "note.md" }),
        };
        yield {
          kind: "runFinished",
          agentId: "worker-1",
          reason: "tool-calls",
          detail: "第一次读取",
        };
        return;
      }
      if (input.recordedInputs.length === 2) {
        await input.tighten();
        yield {
          kind: "toolCallRequested",
          callId: "call-2",
          toolName: "readFile",
          argumentsJson: JSON.stringify({ filePath: "note.md" }),
        };
        yield {
          kind: "runFinished",
          agentId: "worker-1",
          reason: "tool-calls",
          detail: "收紧后再次读取",
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

async function runSwitchScenario(): Promise<{
  readonly firstToolResult: string;
  readonly secondToolResult: string;
  readonly observedProfileAfterSwitch: { kind: string; profileId?: string } | null;
}> {
  const recordedInputs: AgentRunInput[] = [];
  /** 运行期间可调的收紧动作（在 worker 第二轮被调用）。 */
  const tightener: { run: (() => Promise<void>) | null } = { run: null };
  let observedProfileAfterSwitch: { kind: string; profileId?: string } | null = null;
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 6,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
    workerRuntimeFactory: () =>
      buildSwitchingRuntime({
        tighten: async () => {
          if (tightener.run !== null) await tightener.run();
        },
        recordedInputs,
      }),
  });
  try {
    /** 收紧动作：切到空白自定义组（其 `project.read` 回退 deny）。 */
    tightener.run = async () => {
      const created = await runtime.controller.createPermissionProfile({
        displayName: "tightened-deny",
        source: { kind: "blank" },
      });
      await runtime.controller.switchPermissionProfile({
        kind: "custom",
        profileId: created.permissionProfileId,
      });
      /** 先证明"切换对控制器可见"，再把差异归因到执行前重读。 */
      observedProfileAfterSwitch =
        await runtime.controller.getCurrentPermissionProfileReference();
    };
    const missionIdentifier = await runtime.controller.handleUserMessage("权限收紧测试", {
      projectIdentifier: "project-a",
      workspaceRootPath: workspaceDirectory,
    });
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (recordedInputs.length >= 3) break;
      const status = (await runtime.controller.queryMissionStatus(missionIdentifier))
        ?.summary?.status ?? "";
      if (["done", "blocked", "cancelled", "failed"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    /**
     * 取**最后一条**输入的 `toolResultMessages`：它是累积的（含全部历史工具结果），
     * 而 `flatMap` 会把同一结果重复计入，导致"第二次结果"其实还是第一次
     * （本文件首版正是如此，实测把成功的读取误当成收紧后仍成功）。
     */
    const lastInput = recordedInputs[recordedInputs.length - 1];
    const toolResults =
      lastInput === undefined ? [] : extractToolResultTexts(lastInput);
    return {
      firstToolResult: toolResults[0] ?? "",
      secondToolResult: toolResults[1] ?? "",
      observedProfileAfterSwitch,
    };
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("worker 每次工具执行前读取当前有效权限", () => {
  it("收紧前调用成功、收紧后同一 worker 的调用被拒绝", async () => {
    const { firstToolResult, secondToolResult, observedProfileAfterSwitch } =
      await runSwitchScenario();
    /** 切换必须对控制器可见（否则后面"被拒绝"就无从归因）。 */
    expect(observedProfileAfterSwitch?.kind).toBe("custom");
    /** 第一次：assist 下 `project.read` 默认 allow ⇒ 真的读到正文。 */
    expect(firstToolResult).toContain("正文");
    expect(firstToolResult).not.toContain("tool-permission-denied");
    /** 第二次：运行期间切到 deny 组 ⇒ 必须在该次执行前被拒绝。 */
    expect(secondToolResult).toContain("tool-permission-denied");
    expect(secondToolResult).not.toContain("正文");
  }, 60_000);

  it("反例对照：若不切换权限组，第二次调用同样成功（证明差异来自收紧）", async () => {
    const recordedInputs: AgentRunInput[] = [];
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 6,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
      workerRuntimeFactory: () =>
        buildSwitchingRuntime({
          /** 什么都不做：对照组。 */
          tighten: async () => undefined,
          recordedInputs,
        }),
    });
    try {
      const missionIdentifier = await runtime.controller.handleUserMessage("对照组", {
        projectIdentifier: "project-a",
        workspaceRootPath: workspaceDirectory,
      });
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        if (recordedInputs.length >= 3) break;
        const status = (await runtime.controller.queryMissionStatus(missionIdentifier))
          ?.summary?.status ?? "";
        if (["done", "blocked", "cancelled", "failed"].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const toolResults = recordedInputs.flatMap((recordedInput) =>
        extractToolResultTexts(recordedInput),
      );
      expect(toolResults[0]).toContain("正文");
      expect(toolResults[1]).toContain("正文");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
