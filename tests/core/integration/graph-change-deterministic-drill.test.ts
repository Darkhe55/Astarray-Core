/**
 * R136/R137（2026-11-03）：**确定性图变更演练**（不依赖真实模型）。
 *
 * 用"权限询问"制造稳定安全点：假 Provider 请求写工具 ⇒ assist 默认权限触发
 * "需要用户" ⇒ 任务 blocked、在途领取释放，mission 仍活动（等待裁决）。
 *
 * 用例：
 * 1. 正常状态（V=1）注入 ⇒ 接受、审计落盘、V 未上升 ⇒ **不暂停**；
 * 2. 预置"陈旧 V=0"（模拟曾有证据）后注入 ⇒ 重算 V=1 ⇒ **暂停 + 需重新规划**
 *    （覆盖 R134 的 V 上升分支；预置状态在测试目录内，不改产品代码）。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";
import { TaskGraphChangeJournalStore } from "../../../packages/core/src/orchestration/task-graph-change-journal.js";
import { MissionTaskSequenceMapStore } from "../../../packages/core/src/orchestration/mission-task-sequence-map-store.js";

let stateDirectory: string;
let server: http.Server | null = null;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-graph-drill-"));
});

afterEach(async () => {
  if (server !== null) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function sseToolCall(toolName: string, argumentsJson: string): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "tc-1", function: { name: toolName, arguments: argumentsJson } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    "\n\n"
  );
}

async function startWriteAskServer(): Promise<string> {
  server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sseToolCall(
          "createProjectFile",
          JSON.stringify({ filePath: "graph-drill.md", content: "# drill\n" }),
        ),
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${String(address.port)}/v1/chat/completions`;
}

async function waitForTaskBlocked(
  missionIdentifier: string,
  timeoutMilliseconds: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const chainPath = path.join(
      stateDirectory,
      "missions",
      missionIdentifier,
      "task-chain.json",
    );
    const chain = await fs
      .readFile(chainPath, "utf8")
      .then(
        (content) =>
          JSON.parse(content) as { tasks: { id: string; status: string }[] },
      )
      .catch(() => null);
    if (chain === null) {
      continue;
    }
    const blocked = chain.tasks.find((task) => task.status === "blocked");
    if (blocked !== undefined) {
      return blocked.id;
    }
  }
  return null;
}

async function startBlockedMission(): Promise<{
  readonly application: AstarrayApplicationFacade;
  readonly missionIdentifier: string;
  readonly goalIdentifier: string;
}> {
  const endpoint = await startWriteAskServer();
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "provider",
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: "fake-model",
      allowedModelIdentifiers: ["fake-model"],
      requiredCapabilities: ["streaming", "tool-calling"],
      baseUrl: endpoint,
      protectedCredentialReferenceId: "cred-1",
      requestTimeoutMilliseconds: 5_000,
    },
    statusPollIntervalMilliseconds: 10,
  });
  application.activateGoalMode({
    isExplicitUserRequest: true,
    isAuthenticatedUser: true,
    isExplicitlyEnabled: true,
    requestedBy: "user",
  });
  const goalIdentifier = "goal-graph-drill";
  const proposal = await application.proposeGoalContract({
    sourceRequestReference: "user-message:graph-drill",
    draft: {
      objectiveText: "图变更确定性演练",
      requirements: [
        {
          requirementIdentifier: "req-1",
          description: "创建文件完成",
          weight: 1,
          completionPredicateKind: "deterministic-check",
        },
      ],
      scope: { projectIdentifiers: [], allowedToolNames: null },
      nonViolableInvariants: [],
      resourceLimits: {
        maximumToolCalls: 50,
        maximumWallClockSeconds: null,
        maximumCostUnits: null,
      },
      deadlineIso: null,
      pauseConditions: [],
    },
  });
  await application.confirmGoalContract({
    proposalIdentifier: proposal.proposalIdentifier,
    goalIdentifier,
    ownerIdentifier: "user-local",
    activation: {
      isExplicitUserRequest: true,
      isAuthenticatedUser: true,
      isExplicitlyEnabled: true,
      requestedBy: "user",
    },
    isUserConfirmation: true,
  });
  await application.bindRequirementTaskMapping({
    goalIdentifier,
    requirementIdentifier: "req-1",
    taskNodeIdentifiers: ["T-001"],
  });
  application.createSession({ sessionId: "graph-session", mode: "assist" });
  const accepted = await application.submitTask({
    sessionId: "graph-session",
    taskIdentifier: "graph-task",
    prompt: "创建文件 graph-drill.md。",
    goalIdentifier,
  });
  const missionIdentifier = accepted.missionIdentifier;
  if (missionIdentifier === undefined || missionIdentifier === null) {
    throw new Error("submitTask 未返回 missionIdentifier");
  }
  const blockedTaskId = await waitForTaskBlocked(missionIdentifier, 20_000);
  expect(blockedTaskId).toBe("T-001");
  return { application, missionIdentifier, goalIdentifier };
}

describe("确定性图变更演练", () => {
  it("V 未上升 ⇒ 注入接受、审计落盘、目标不暂停", async () => {
    const { application, missionIdentifier, goalIdentifier } =
      await startBlockedMission();
    try {
      const injection = await application.injectMissionTask(missionIdentifier, {
        id: "T-99",
        description: "注入：读取 graph-drill.md",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
      });
      expect(injection.outcome).toBe("injected");

      const chain = JSON.parse(
        await fs.readFile(
          path.join(stateDirectory, "missions", missionIdentifier, "task-chain.json"),
          "utf8",
        ),
      ) as { tasks: { id: string; status: string }[] };
      expect(chain.tasks.map((task) => task.id)).toContain("T-99");

      const journal = new TaskGraphChangeJournalStore({
        baseDirectory: stateDirectory,
      });
      const entries = await journal.listForMission(missionIdentifier);
      expect(
        entries.some(
          (entry) =>
            entry.changeKind === "inject" && entry.taskIdentifier === "T-99",
        ),
      ).toBe(true);

      /**
       * 目标重算在编排循环里异步落盘：轮询到 V 重算完成（最多 3s），
       * 避免负载下"注入返回但重算未落盘"的假失败。
       */
      const goalStatePath = path.join(
        stateDirectory,
        "goal-mode",
        `${goalIdentifier}.json`,
      );
      let goalState = JSON.parse(await fs.readFile(goalStatePath, "utf8")) as {
        requiresReplanning: boolean;
        pauseReason: string | null;
        lastPotentialValue: number;
      };
      const goalDeadline = Date.now() + 3_000;
      while (Date.now() < goalDeadline && goalState.lastPotentialValue !== 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        goalState = JSON.parse(await fs.readFile(goalStatePath, "utf8")) as typeof goalState;
      }
      expect(goalState.requiresReplanning).toBe(false);
      expect(goalState.pauseReason).toBeNull();
      expect(goalState.lastPotentialValue).toBe(1);
    } finally {
      await application.shutdown();
    }
  });

  it("预置陈旧 V=0 后注入 ⇒ 重算 V=1 上升 ⇒ 目标暂停并需重新规划", async () => {
    const { application, missionIdentifier, goalIdentifier } =
      await startBlockedMission();
    try {
      /** 预置"上次算过 V=0"（模拟曾有证据）；不改产品代码，只改测试状态目录。 */
      const statePath = path.join(
        stateDirectory,
        "goal-mode",
        `${goalIdentifier}.json`,
      );
      const seeded = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown> & {
        gateSnapshot: Record<string, unknown>;
      };
      seeded.lastPotentialValue = 0;
      seeded.gateSnapshot = {
        ...seeded.gateSnapshot,
        lastPotentialValue: 0,
      };
      await fs.writeFile(statePath, JSON.stringify(seeded, null, 2), "utf8");

      const injection = await application.injectMissionTask(missionIdentifier, {
        id: "T-99",
        description: "注入：读取 graph-drill.md",
        dependsOn: ["T-001"],
        taskType: "data",
        toolNames: ["readFile"],
      });
      expect(injection.outcome).toBe("injected");

      /** 联动是异步写入：轮询到暂停落盘（最多 3s）。 */
      let goalState = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        requiresReplanning: boolean;
        pauseReason: string | null;
        lastPotentialValue: number;
      };
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !goalState.requiresReplanning) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        goalState = JSON.parse(await fs.readFile(statePath, "utf8")) as typeof goalState;
      }
      expect(goalState.lastPotentialValue).toBe(1);
      expect(goalState.requiresReplanning).toBe(true);
      expect(goalState.pauseReason).toContain("V 上升");

      /** 恢复后自动继续：replan 清停顿后，同一 mission 的派发控制面应立即可用（无需重建 mission）。 */
      const resumed = await application.replanGoal({
        goalIdentifier,
        note: "演练：确认 V 上升原因后继续",
      });
      expect(resumed.resumed).toBe(true);
      const afterReplan = await application.injectMissionTask(missionIdentifier, {
        id: "T-98",
        description: "恢复后继续：只读检查",
        dependsOn: ["T-001"],
        taskType: "data",
        toolNames: ["readFile"],
      });
      expect(afterReplan.outcome, JSON.stringify(afterReplan)).toBe("injected");
    } finally {
      await application.shutdown();
    }
  });
});

describe("确定性图变更演练：修订/重连/删除", () => {
  it("同一安全点内注入 → 修订 → 重连 → 删除；审计按序落盘且目标不暂停", async () => {
    const { application, missionIdentifier, goalIdentifier } =
      await startBlockedMission();
    try {
      const injection = await application.injectMissionTask(missionIdentifier, {
        id: "T-99",
        description: "注入：读取 graph-drill.md",
        dependsOn: ["T-001"],
        taskType: "data",
        toolNames: ["readFile"],
      });
      expect(injection.outcome).toBe("injected");

      const revised = await application.reviseMissionTask(missionIdentifier, "T-99", {
        description: "注入后修订：读取并汇报",
        toolNames: ["readFile", "searchProjectText"],
      });
      expect(revised.outcome).toBe("revised");

      /** 依赖仍指向被权限阻塞的 T-001：重连后仍 pending，避免被调度器立刻启动。 */
      const rewired = await application.rewireMissionTaskDependencies(
        missionIdentifier,
        "T-99",
        ["T-001"],
      );
      expect(rewired.outcome, JSON.stringify(rewired)).toBe("rewired");

      /** 先登记一条映射，删除任务后应被清理（链路，而非仅存储单测）。 */
      const mapStore = new MissionTaskSequenceMapStore({
        baseDirectory: stateDirectory,
      });
      await mapStore.bind({
        missionIdentifier,
        sequenceIdentifier: "sequence-drill",
        ownerAgentInstanceIdentifier: "scheduler:drill",
        missionTaskIdentifier: "T-99",
        sequenceTaskIdentifier: "node-99",
      });

      const removed = await application.removeMissionTask(missionIdentifier, "T-99");
      expect(removed.outcome).toBe("removed");

      const mapDeadline = Date.now() + 3_000;
      let remainingMappings = await mapStore.listForMission({
        missionIdentifier,
        sequenceIdentifier: "sequence-drill",
      });
      while (Date.now() < mapDeadline && remainingMappings.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        remainingMappings = await mapStore.listForMission({
          missionIdentifier,
          sequenceIdentifier: "sequence-drill",
        });
      }
      expect(remainingMappings).toEqual([]);

      const chain = JSON.parse(
        await fs.readFile(
          path.join(stateDirectory, "missions", missionIdentifier, "task-chain.json"),
          "utf8",
        ),
      ) as { tasks: { id: string }[] };
      expect(chain.tasks.map((task) => task.id)).not.toContain("T-99");

      const journal = new TaskGraphChangeJournalStore({
        baseDirectory: stateDirectory,
      });
      const entries = await journal.listForMission(missionIdentifier);
      expect(entries.map((entry) => entry.changeKind)).toEqual([
        "inject",
        "revise",
        "rewire",
        "remove",
      ]);

      const goalState = JSON.parse(
        await fs.readFile(
          path.join(stateDirectory, "goal-mode", `${goalIdentifier}.json`),
          "utf8",
        ),
      ) as { requiresReplanning: boolean; pauseReason: string | null };
      expect(goalState.requiresReplanning).toBe(false);
      expect(goalState.pauseReason).toBeNull();
    } finally {
      await application.shutdown();
    }
  });
});
