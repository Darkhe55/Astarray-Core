/**
 * R136（2026-11-03）：**确定性图变更演练**（不依赖真实模型）。
 *
 * 场景：假 Provider 先请求写文件 ⇒ assist 默认权限触发"需要用户" ⇒ 任务被 blocked、
 * 在途领取被释放，mission 仍处于活动状态（等待裁决）。此时是**安全点**：
 * 注入新任务应被接受，且因为 V 未上升（mapped T-001 仍未完成）目标**不应被暂停**。
 *
 * 断言：
 * 1. 权限询问确实发生（任务进入 blocked）；
 * 2. 注入被接受，任务链含 T-99；
 * 3. 图变更审计落盘一条 inject；
 * 4. 目标状态：requiresReplanning=false、pauseReason=null、lastPotentialValue=1。
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

describe("确定性图变更演练（R136）", () => {
  it("权限阻塞期注入：接受、审计落盘、V 未上升 ⇒ 不暂停", async () => {
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
    try {
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
            maximumToolCalls: 10,
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
      const blockedTaskId = await waitForTaskBlocked(missionIdentifier, 20_000);
      expect(blockedTaskId).toBe("T-001");

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
      expect(entries.some((entry) => entry.changeKind === "inject" && entry.taskIdentifier === "T-99")).toBe(true);

      const goalState = JSON.parse(
        await fs.readFile(
          path.join(stateDirectory, "goal-mode", `${goalIdentifier}.json`),
          "utf8",
        ),
      ) as {
        requiresReplanning: boolean;
        pauseReason: string | null;
        lastPotentialValue: number;
      };
      expect(goalState.requiresReplanning).toBe(false);
      expect(goalState.pauseReason).toBeNull();
      expect(goalState.lastPotentialValue).toBe(1);
    } finally {
      await application.shutdown();
    }
  });
});
