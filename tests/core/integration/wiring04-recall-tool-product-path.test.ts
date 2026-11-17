/**
 * WIRING-04-05 产品路径（2026-11-18）：**回访工具端到端可达**。
 *
 * 链路：假 Provider 首次返回 `recallClosedContext` 工具调用
 * → 权威工具执行（真权限/注册表）→ 结果回填
 * → **第二次请求体里必须出现该工具结果**。
 *
 * 不断言任务终态：本用例只证明"工具真的被执行且结果真的回到模型面前"。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

vi.setConfig({ testTimeout: 120_000 });

let temporaryDirectory: string;
let server: http.Server | null = null;
let receivedBodies: string[] = [];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-recall-e2e-"));
  receivedBodies = [];
});

afterEach(async () => {
  if (server !== null) {
    const closingServer = server;
    server = null;
    await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    closingServer.closeAllConnections?.();
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
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
              { index: 0, id: "tc-recall-1", function: { name: toolName, arguments: argumentsJson } },
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

async function startScriptedServer(): Promise<string> {
  server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      receivedBodies.push(rawBody);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      /** 第 1 次：任务分解（必须给出合法草案，否则会走单节点降级）。 */
      if (receivedBodies.length === 1) {
        response.write(
          sseContent(
            JSON.stringify({
              nodes: [
                {
                  id: "T-001",
                  description: "查询历史上下文",
                  acceptanceCriteria: "给出回访结果或明确的拒绝原因",
                  dependsOn: [],
                  toolNames: ["recallClosedContext"],
                },
              ],
            }),
          ),
        );
        response.end();
        return;
      }
      /** 第 2 次：worker 请求回访工具。 */
      if (receivedBodies.length === 2) {
        response.write(
          sseToolCall(
            "recallClosedContext",
            JSON.stringify({
              contextNodeIdentifier: "node-does-not-exist",
              nodeRevision: 1,
              reasonCode: "user-new-requirement",
              requiredInformation: "需要历史上游结论",
              maximumTokenCount: 256,
            }),
          ),
        );
        response.end();
        return;
      }
      /** 第 3 次起：收到工具结果后收尾。 */
      response.write(sseContent("已收到回访结果。"));
      response.end();
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

describe("WIRING-04-05：回访工具产品路径", () => {
  it("① 模型请求回访工具 ⇒ 工具真的执行，结果进入下一次请求", async () => {
    const endpoint = await startScriptedServer();
    const application = await createApplication(endpoint);
    try {
      await application.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "查询历史上下文",
      });

      const deadline = Date.now() + 60_000;
      while (receivedBodies.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(receivedBodies.length).toBeGreaterThanOrEqual(3);
      const thirdRequestBody = receivedBodies[2] ?? "";
      /** 工具结果消息存在，且正是本轮那次回访调用（call id 对得上）。 */
      expect(thirdRequestBody).toContain('"role":"tool"');
      expect(thirdRequestBody).toContain('"tool_call_id":"tc-recall-1"');
      const toolMessageIndex = thirdRequestBody.indexOf('"role":"tool"');
      const toolMessageText = thirdRequestBody.slice(toolMessageIndex, toolMessageIndex + 500);
      /** 结果由**回访控制器**给出：节点不存在时是 not-found，并附候选提示。 */
      expect(toolMessageText).toContain("context-recall-refused");
      expect(toolMessageText).toContain("not-found");
    } finally {
      await application.shutdown().catch(() => undefined);
    }
  }, 120_000);
});
