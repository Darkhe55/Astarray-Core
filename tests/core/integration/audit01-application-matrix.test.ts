/**
 * AUDIT-REPAIR-01 检查点 01 收口（EXEC-01-05，2026-11-09）：**应用级 allow/deny 矩阵**。
 *
 * 为什么单独写：此前唯一的门禁用例用旧 `PermissionDecider` + `ModeMachine` 手工装配，
 * 没有覆盖真实 `createApplicationRuntime` 装配下的四类不同结果，也没有"真实提案产物"
 * 证据（只看 mission done 不够）。
 *
 * 观测方式：worker 运行时的第二轮输入带 `toolResultMessages`，工具结果就在里面。
 * 这比"看 streamOutput"可靠 —— 工具结果不一定会被流式输出。
 *
 * 实测得到的一处**事实纠正**：`proposeGoal` 的描述符会被单节点分解授予**每个**任务，
 * 所以"未分配"（子集拒绝）在默认路径上不可达；它只出现在分解显式声明了更小工具子集时。
 * 因此本文件用 `taskDecompositionDraftProvider` 显式构造该场景，而不是假设它自然发生。
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-audit01-matrix-"));
  streamedTexts = [];
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 6 });
});

interface ToolResultMessage {
  readonly role?: string;
  readonly content?: unknown;
}

function extractToolResultText(runInput: AgentRunInput): string {
  const messages = (runInput as unknown as { toolResultMessages?: ToolResultMessage[] })
    .toolResultMessages;
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

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
          callId: "call-matrix",
          toolName: "proposeGoal",
          argumentsJson: input.argumentsJson,
        };
        yield {
          kind: "runFinished",
          agentId: "worker-1",
          reason: "tool-calls",
          detail: "调用 proposeGoal",
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

async function listContractFiles(): Promise<string[]> {
  try {
    const fileNames = await fs.readdir(path.join(stateDirectory, "goal-mode", "contracts"));
    return fileNames.filter((fileName) => fileName.endsWith(".json"));
  } catch {
    return [];
  }
}

async function listProposalFiles(): Promise<string[]> {
  try {
    const fileNames = await fs.readdir(path.join(stateDirectory, "goal-mode", "proposals"));
    return fileNames.filter((fileName) => fileName.endsWith(".json"));
  } catch {
    return [];
  }
}

const validProposalArguments = JSON.stringify({
  objectiveText: "把只读视图补齐到可验收",
  requirements: [
    {
      requirementIdentifier: "req-1",
      description: "视图能列出任务",
      evidenceRequirement: "artifact",
      weight: 1,
    },
  ],
});

async function runMatrixCase(input: {
  readonly mode: "assist" | "devolve" | "ponder";
  readonly isGoalModeActivated: boolean;
  /** 传入则用分解显式限定工具子集（用于构造"未分配"）。 */
  readonly restrictedToolNames?: readonly string[];
  /** `blank-custom`：切换到空白自定义权限组（`goal.propose` 回退 deny）。 */
  readonly permissionProfileSource?: "blank-custom";
}): Promise<{
  readonly toolResultText: string;
  readonly streamedText: string;
  readonly proposalFiles: string[];
}> {
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
    /**
     * 同一个工厂要服务两种调用：规划器（`planner:*`）只取一次文本答复，
     * worker 走工具调用。规划器路径用于构造"受限工具子集"场景。
     */
    workerRuntimeFactory: (agentInstanceIdentifier: string) => {
      if (agentInstanceIdentifier.startsWith("planner:")) {
        return {
          async *run(): AsyncIterable<AgentEvent> {
            yield {
              kind: "textDelta",
              deltaText: JSON.stringify({
                nodes: [
                  {
                    id: "T-001",
                    description: "矩阵用例（受限工具子集）",
                    dependsOn: [],
                    acceptanceCriteria: "工具结果可观测",
                    toolNames: [...(input.restrictedToolNames ?? [])],
                  },
                ],
              }),
            };
          },
        } as AgentRuntime;
      }
      return buildScriptedRuntime({
        argumentsJson: validProposalArguments,
        recordedInputs,
      });
    },
    ...(input.restrictedToolNames === undefined
      ? {}
      : { isModelTaskPlanningEnabled: true }),
  });
  try {
    if (input.isGoalModeActivated) {
      const activation = runtime.activateGoalMode({
        isExplicitUserRequest: true,
        isAuthenticatedUser: true,
        isExplicitlyEnabled: true,
        requestedBy: "user",
      });
      expect(activation.isActive).toBe(true);
    }
    if (input.permissionProfileSource === "blank-custom") {
      /**
       * 用**项目级作用域覆盖**切到空白自定义组（`goal.propose` 回退 deny）。
       *
       * 为什么不用 `switchPermissionProfile`：实测它对 worker 的工具端口不生效
       * （worker 用的 profile 引用在装配时固定，不读当前选择）—— 那是另一处缺口，
       * 不在本用例范围内；作用域覆盖是 worker 真正消费的路径。
       */
      const created = await runtime.controller.createPermissionProfile({
        displayName: "matrix-blank",
        source: { kind: "blank" },
      });
      const currentScopedSettings = await runtime.scopedSettingsStore.read();
      await runtime.scopedSettingsStore.updatePermission({
        scope: "project",
        identifier: "project-a",
        expectedRevision: currentScopedSettings.revision,
        permissionProfileId: created.permissionProfileId,
        updatedByUserId: "user-1",
      });
    }
    const missionIdentifier = await runtime.controller.handleUserMessage("矩阵用例", {
      projectIdentifier: "project-a",
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (recordedInputs.length >= 2) break;
      const status = (await runtime.controller.queryMissionStatus(missionIdentifier))
        ?.summary?.status ?? "";
      if (["done", "blocked", "cancelled", "failed"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      toolResultText: recordedInputs
        .map((recordedInput) => extractToolResultText(recordedInput))
        .filter((text) => text !== "")
        .join("\n"),
      streamedText: streamedTexts.join("\n"),
      proposalFiles: await listProposalFiles(),
    };
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("AUDIT-REPAIR-01 应用级矩阵", () => {
  it("未暴露：主 Agent 工具投影不含 proposeGoal", async () => {
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
      expect(names).not.toContain("proposeGoal");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("已激活但未分配：目标模式激活不构成工具分配 ⇒ 拒绝且无提案文件", async () => {
    /**
     * 用户裁决（2026-11-09）：**目标模式激活不构成工具分配或授权**。
     *
     * 此前装配层在激活时把 `proposeGoal` 强行加进允许列表，于是"只授予 readFile"
     * 的任务仍能成功提议目标（实测复现）。现在必须被本地子集拒绝，且不落盘。
     */
    const { toolResultText, proposalFiles } = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: true,
      restrictedToolNames: ["readFile"],
    });
    expect(toolResultText).toContain("不在本 Worker 授权子集内");
    expect(proposalFiles).toEqual([]);
    expect(await listContractFiles()).toEqual([]);
  }, 90_000);

  it("已分配但 deny：统一权限门禁拒绝，且无提案文件", async () => {
    const { toolResultText, proposalFiles } = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: true,
      /** 空白自定义组：`goal.propose` 无显式决定 ⇒ 回退 deny。 */
      permissionProfileSource: "blank-custom",
    });
    /** 权限引擎拒绝：工具未被放行到处理器（错误码 + 工具名，不含规则细节）。 */
    expect(toolResultText).toContain("tool-permission-denied");
    expect(toolResultText).toContain("proposeGoal");
    expect(toolResultText).not.toContain("目标提案已创建");
    expect(proposalFiles).toEqual([]);
    expect(await listContractFiles()).toEqual([]);
  }, 90_000);

  it("已分配且合法授权：只保存待确认提案，不生成契约", async () => {
    const { proposalFiles } = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: true,
    });
    expect(proposalFiles.length).toBe(1);
    /** "仅保存待确认提案"：提案存在，但**没有**契约文件。 */
    expect(await listContractFiles()).toEqual([]);
    const content = JSON.parse(
      await fs.readFile(
        path.join(stateDirectory, "goal-mode", "proposals", proposalFiles[0] as string),
        "utf8",
      ),
    ) as { proposalIdentifier?: string; draft?: { objectiveText?: string } };
    expect(typeof content.proposalIdentifier).toBe("string");
    expect(content.draft?.objectiveText).toContain("只读视图");
  }, 90_000);

  it("未分配：分解只授予 readFile 且目标模式未激活 ⇒ 子集拒绝，且不落盘", async () => {
    /**
     * 为什么这里必须"未激活"：目标模式激活时装配层会把 `proposeGoal`
     * **强行加进**允许列表（`effectiveAllowedToolNames.add(...)`），
     * 因此受限子集在激活状态下对它不生效。这是本矩阵暴露出的**待裁决项**，
     * 已记入卡内（是否应让任务工具子集对 proposeGoal 生效属产品决策），
     * 这里只断言"未激活时子集确实生效"这一确定事实。
     */
    const { toolResultText, proposalFiles } = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: false,
      restrictedToolNames: ["readFile"],
    });
    expect(toolResultText).toContain("不在本 Worker 授权子集内");
    expect(proposalFiles).toEqual([]);
  }, 90_000);

  it("权限待询问：已激活 + assist ⇒ 询问用户，且不落盘", async () => {
    const { streamedText, toolResultText, proposalFiles } = await runMatrixCase({
      mode: "assist",
      isGoalModeActivated: true,
    });
    /** 实际观测到的形态是 permission-ask-pending（不是笼统的"需要权限"）。 */
    expect(streamedText + toolResultText).toMatch(/permission-ask-pending/u);
    expect(streamedText + toolResultText).toContain("proposeGoal");
    expect(proposalFiles).toEqual([]);
  }, 90_000);

  it("处理器拒绝：未激活 + devolve ⇒ 处理器报目标模式未激活，且不落盘", async () => {
    const { toolResultText, proposalFiles } = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: false,
    });
    expect(toolResultText).toContain("目标模式未激活");
    expect(proposalFiles).toEqual([]);
  }, 90_000);

  it("成功落盘：已激活 + devolve ⇒ 真实提案文件存在且内容可读（不只看 mission done）", async () => {
    const { proposalFiles } = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: true,
    });
    expect(proposalFiles.length).toBe(1);
    const content = JSON.parse(
      await fs.readFile(
        path.join(stateDirectory, "goal-mode", "proposals", proposalFiles[0] as string),
        "utf8",
      ),
    ) as { proposalIdentifier?: string; draft?: { objectiveText?: string } };
    expect(typeof content.proposalIdentifier).toBe("string");
    expect(content.draft?.objectiveText).toContain("只读视图");
  }, 90_000);

  it("同一断言对：未激活不落盘、激活才落盘", async () => {
    const withoutActivation = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: false,
    });
    expect(withoutActivation.proposalFiles).toEqual([]);
    streamedTexts = [];
    const withActivation = await runMatrixCase({
      mode: "devolve",
      isGoalModeActivated: true,
    });
    expect(withActivation.proposalFiles.length).toBe(1);
  }, 120_000);
});
