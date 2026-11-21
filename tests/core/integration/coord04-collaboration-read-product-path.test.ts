/**
 * COORD-04 §7 产品路径（2026-11-21，用户裁决："worker 序列由上级 agent 或用户在认定需要时创建"）：
 *
 * 夹具按该裁决构造：**用户**（或上级）在任务运行中为 worker 按需创建任务序列并种入协作消息；
 * 假 Provider 首次返回 `taskSequenceStatus` 工具调用 → 真实权限/执行 → 结果回填；
 * **第二次请求体里必须出现 pendingCollaboration**（关系标识 + 摘要），且收件箱状态不变。
 *
 * 这条用例同时证明：读取出口与任务序列同为"按需"——没有序列时不读；有序列时同口读出。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { TaskSequenceManageController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let temporaryDirectory: string;
let server: http.Server | null = null;
let receivedBodies: string[] = [];
let seededWorkerId: string | null = null;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord04-read-e2e-"));
  receivedBodies = [];
  seededWorkerId = null;
});

afterEach(async () => {
  if (server !== null) {
    const closingServer = server;
    server = null;
    await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    closingServer.closeAllConnections?.();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function sseToolCall(toolName: string, argumentsJson: string): string {
  return (
    "data: " +
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "tc-status-1",
                function: { name: toolName, arguments: argumentsJson },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) +
    "\n\n"
  );
}

function sseContent(text: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }) +
    "\n\n"
  );
}

async function discoverWorkerTaskId(rawRequestBody: string): Promise<{ missionId: string; taskId: string }> {
  const missionsDirectory = path.join(temporaryDirectory, "missions");
  const missions = (await fs.readdir(missionsDirectory)).filter((name) => !name.endsWith(".lock"));
  const missionId = missions[0];
  if (missionId === undefined) {
    throw new Error("夹具失败：找不到 mission 目录");
  }
  const chainPath = path.join(missionsDirectory, missionId, "task-chain.json");
  const chain = JSON.parse(await fs.readFile(chainPath, "utf8")) as {
    nodes?: Array<{ id: string }>;
  };
  const taskId = chain.nodes?.[0]?.id;
  if (taskId !== undefined) {
    return { missionId, taskId };
  }
  const match = /- 任务：(.+?)（/.exec(rawRequestBody);
  if (match?.[1] === undefined) {
    throw new Error("夹具失败：拿不到 worker 任务 id（链文件与简报都没有）");
  }
  return { missionId, taskId: match[1].trim() };
}

/** 用户/上级按需为 worker 建序列并种入一条已授权的协作请求。 */
async function seedWorkerState(input: { rawRequestBody: string; sequenceId: string }): Promise<string> {
  const { missionId, taskId } = await discoverWorkerTaskId(input.rawRequestBody);
  const workerId = `worker:${missionId}:${taskId}:1`;

  const sequenceStore = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
  const manageController = new TaskSequenceManageController(sequenceStore);
  await manageController.publishSequence({
    ownerAgentInstanceId: workerId,
    actor: { sourceKind: "user", actorId: "user-1" },
    sequenceId: input.sequenceId,
    firstTask: { taskId: "seed-task", title: "待读取协作请求", priorityTier: null, externalReference: null },
  });

  await new CrossProjectAuthorizationStore({ baseDirectory: temporaryDirectory }).grantAuthorization({
    authorizationIdentifier: "authorization-1",
    sourceProjectIdentifier: "project-a",
    sourceProjectRevision: 1,
    targetProjectIdentifier: "project-b",
    targetProjectRevision: 1,
    operationKind: "read",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: `sha256:${"0".repeat(64)}`,
    expiresAtIso: "2026-12-31T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "seed-task",
    receivingAgentInstanceId: workerId,
    nowIso: "2026-11-20T00:00:00.000Z",
  });

  const inbox = new CollaborationInbox({
    maximumPendingPerRecipient: 5,
    maximumDeliveryAttempts: 3,
  } as never);
  inbox.enqueue({
    messageIdentifier: "message-collab",
    correlationIdentifier: "corr-collab",
    recipientAgentInstanceId: workerId,
    senderAgentInstanceId: "agent-a1",
    taskIdentifier: "seed-task",
    summary: "请先核对导出一致性",
    receivedAtIso: "2026-11-21T00:00:00.000Z",
    authorizationIdentifier: "authorization-1",
    authorizationEpoch: 1,
  } as never);
  await new CollaborationInboxStore({ baseDirectory: temporaryDirectory }).save(workerId, {
    messages: inbox.toSnapshot(),
    expectedRevision: 0,
    updatedAtIso: "2026-11-21T00:00:01.000Z",
  });
  seededWorkerId = workerId;
  return workerId;
}

async function startSeedingServer(sequenceId: string): Promise<string> {
  server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      void (async () => {
        const isFirst = receivedBodies.length === 0;
        receivedBodies.push(rawBody);
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        if (isFirst) {
          try {
            await seedWorkerState({ rawRequestBody: rawBody, sequenceId });
            response.write(sseToolCall("taskSequenceStatus", JSON.stringify({ sequenceId })));
          } catch (error) {
            /** 夹具失败时把原因透传到第二次请求，避免"空断言"假绿。 */
            response.write(sseContent("夹具失败：" + (error as Error).message));
            response.end();
            return;
          }
        } else {
          response.write(sseContent("已读取。"));
        }
        response.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + address.port + "/v1/chat/completions";
}

async function createApplication(endpoint: string) {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  const application = await AstarrayApplicationFacade.create({
    stateDirectory: temporaryDirectory,
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
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

describe("COORD-04 产品路径：任务列表与协作请求同一读出点", () => {
  it("① 按需建序列后，taskSequenceStatus 的结果进入第二次请求且含 pendingCollaboration", async () => {
    const sequenceId = "seq-worker";
    const endpoint = await startSeedingServer(sequenceId);
    const application = await createApplication(endpoint);
    try {
      await application.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "读取并确认协作请求",
      });

      const deadline = Date.now() + 60_000;
      while (receivedBodies.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (receivedBodies.length < 2) {
        throw new Error(
          "夹具失败：第二次请求未发生。首次响应=" + (receivedBodies[0] ?? "<无>").slice(0, 400),
        );
      }

      const secondRequestBody = receivedBodies[1] as string;
      expect(secondRequestBody).toContain("pendingCollaboration");
      expect(secondRequestBody).toContain("message-collab");
      expect(secondRequestBody).toContain("请先核对导出一致性");

      /** 解析第二次请求里的**工具结果**，按结构断言（不靠转义后的字面量）。 */
      const body = JSON.parse(secondRequestBody) as {
        messages: Array<{ role: string; content?: string | null }>;
      };
      const toolMessage = body.messages.find((entry) => entry.role === "tool");
      expect(toolMessage?.content).toBeTruthy();
      const toolResult = JSON.parse(toolMessage?.content as string) as {
        pendingCollaboration?: {
          isAvailable: boolean;
          items: Array<{ messageIdentifier: string; summary: string }>;
          skippedUnauthorizedCount: number;
          readOnlyNotice: string;
        };
      };
      expect(toolResult.pendingCollaboration?.isAvailable).toBe(true);
      expect(toolResult.pendingCollaboration?.items[0]).toMatchObject({
        messageIdentifier: "message-collab",
        summary: "请先核对导出一致性",
      });
      expect(toolResult.pendingCollaboration?.readOnlyNotice).toContain("读取不改变消息状态");

      /** 读取不改状态：消息仍是 received、交付尝试 0。 */
      const persisted = await new CollaborationInboxStore({
        baseDirectory: temporaryDirectory,
      }).read(seededWorkerId as string);
      if (persisted.kind !== "valid") {
        throw new Error("夹具失败：收件箱不可读");
      }
      const message = persisted.snapshot.messages.find(
        (candidate) => candidate.messageIdentifier === "message-collab",
      );
      expect(message?.state).toBe("received");
      expect(message?.deliveryAttemptCount).toBe(0);
    } finally {
      await application.shutdown().catch(() => undefined);
    }
  }, 120_000);
});
