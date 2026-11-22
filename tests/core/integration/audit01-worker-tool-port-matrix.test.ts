/**
 * AUDIT-REPAIR-01 检查点 01（2026-11-22）：**应用装配级**矩阵（装配端口直测）。
 *
 * 通过运行时真实构建的 worker 工具端口（`buildWorkerToolPort`）调用 `proposeGoal`：
 * - 未分配 ⇒ `tool-permission-denied`，且不落提案；
 * - 已分配但 assist 为 ask ⇒ `permission-ask-pending`（未批准不落提案）。
 *
 * 这样至少覆盖了"装配端口 + 统一策略 + 自定义处理器"这一层，而不是只测 handler。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { GOAL_PROPOSAL_TOOL_NAME } from "../../../packages/core/src/tools/goal-proposal-tool.js";
import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";

let temporaryDirectory: string;
let stateDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-audit01-assembly-"));
  stateDirectory = path.join(temporaryDirectory, ".astarray");
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory, { recursive: true });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function task(): TaskDependencyNode {
  return {
    id: "T-1",
    description: "提议目标",
    dependsOn: [],
    taskType: "data",
    toolNames: [GOAL_PROPOSAL_TOOL_NAME],
    assignedAgentId: "agent-w1",
    status: "pending",
    resultLocation: null,
  };
}

const proposalArguments = JSON.stringify({
  objectiveText: "让构建稳定",
  requirements: [],
});

async function proposalFileCount(): Promise<number> {
  try {
    const entries = await fs.readdir(path.join(stateDirectory, "goal-mode", "proposals"));
    return entries.length;
  } catch {
    return 0;
  }
}

describe("AUDIT-REPAIR-01 01：装配端口矩阵", () => {
  it("① 未分配 proposeGoal ⇒ tool-permission-denied，处理器不落提案", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      const runtime = (
        application as unknown as {
          runtime: {
            controller: {
              options: {
                buildWorkerToolPort: (
              task: TaskDependencyNode,
              allowedToolNames: Set<string>,
              agentInstanceId?: string,
              workspaceRootPath?: string,
              projectIdentifier?: string,
              missionIdentifier?: string,
              conversationIdentifier?: string,
                ) => { execute: (name: string, args: string, callId: string, signal: AbortSignal) => Promise<unknown> };
              };
            };
          };
        }
      ).runtime;
      const port = runtime.controller.options.buildWorkerToolPort(
        task(),
        new Set(["readFile"]),
        "agent-w1",
        workspaceDirectory,
        "project-1",
        "mission-1",
        "conversation-1",
      );
      const result = (await port.execute(
        GOAL_PROPOSAL_TOOL_NAME,
        proposalArguments,
        "call-unassigned",
        new AbortController().signal,
      )) as { kind: string; errorCode?: string };
      expect(result.kind).toBe("error");
      expect(result.errorCode).toBe("tool-permission-denied");
      expect(await proposalFileCount()).toBe(0);
    } finally {
      await application.shutdown();
    }
  });

  it("② 已分配但 assist 为 ask ⇒ permission-ask-pending，未批准不落提案", async () => {
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      statusPollIntervalMilliseconds: 10,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      const runtime = (
        application as unknown as {
          runtime: {
            controller: {
              options: {
                buildWorkerToolPort: (
              task: TaskDependencyNode,
              allowedToolNames: Set<string>,
              agentInstanceId?: string,
              workspaceRootPath?: string,
              projectIdentifier?: string,
              missionIdentifier?: string,
              conversationIdentifier?: string,
                ) => { execute: (name: string, args: string, callId: string, signal: AbortSignal) => Promise<unknown> };
              };
            };
          };
        }
      ).runtime;
      const port = runtime.controller.options.buildWorkerToolPort(
        task(),
        new Set([GOAL_PROPOSAL_TOOL_NAME]),
        "agent-w1",
        workspaceDirectory,
        "project-1",
        "mission-1",
        "conversation-1",
      );
      const result = (await port.execute(
        GOAL_PROPOSAL_TOOL_NAME,
        proposalArguments,
        "call-ask",
        new AbortController().signal,
      )) as { kind: string; errorCode?: string };
      expect(result.kind).toBe("error");
      expect(result.errorCode).toBe("permission-ask-pending");
      expect(await proposalFileCount()).toBe(0);
    } finally {
      await application.shutdown();
    }
  });
});
