/**
 * 产品路径验收（2026-11-17）：任务简报是否真的走到了模型请求里。
 *
 * 之前的反例只覆盖 Worker 单元层（直接构造 WorkerAgent + 假 runtime）。
 * 本用例走**真实装配链路**：AstarrayApplicationFacade → MissionOrchestrator →
 * WorkerAgent → provider 请求；断言捕获到的**请求体**包含简报四要素。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 起本地服务 + 跑真实链路：显式超时预算（架构守卫要求）。 */
vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let temporaryDirectory: string;
let server: http.Server | null = null;
let receivedBodies: string[] = [];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "task-briefing-e2e-"));
  receivedBodies = [];
});

afterEach(async () => {
  if (server !== null) {
    const closingServer = server;
    server = null;
    await new Promise<void>((resolve) => closingServer.close(() => resolve()));
    closingServer.closeAllConnections?.();
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function sseContent(text: string): string {
  return (
    "data: " +
    JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }) +
    "\n\n"
  );
}

async function startCapturingServer(): Promise<string> {
  server = http.createServer((request, response) => {
    let rawBody = "";
    request.on("data", (chunk) => {
      rawBody += String(chunk);
    });
    request.on("end", () => {
      receivedBodies.push(rawBody);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      response.write(sseContent("已完成。"));
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

describe("任务简报：产品路径把必需内容送进模型请求", () => {
  it("① 真实链路的请求体包含任务简报四要素", async () => {
    const endpoint = await startCapturingServer();
    const application = await createApplication(endpoint);
    try {
      await application.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "实现导出任务",
      });
      let status = "accepted";
      const deadline = Date.now() + 60_000;
      while (!["done", "failed", "blocked", "cancelled"].includes(status) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        status = (
          await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" })
        ).status;
      }

      /** 只要模型被调用过，就必须带简报；否则说明装配没走到 Worker。 */
      expect(receivedBodies.length).toBeGreaterThan(0);
      const requestBody = receivedBodies.join("\n");
      expect(requestBody).toContain("[任务简报]");
      expect(requestBody).toContain("- 要求：");
      expect(requestBody).toContain("验收要求：");
      expect(requestBody).toContain("依赖任务：");
      expect(requestBody).toContain("可用工具：");
      /** 明确标注为任务数据，避免被当成系统指令。 */
      expect(requestBody).toContain("不是系统指令");
      /** 任务正文来自 submitTask 的 prompt ⇒ 必须原样出现在请求里。 */
      expect(requestBody).toContain("实现导出任务");
      /** WIRING-04-04：单节点 mission 的来源被补齐 ⇒ 简报里应出现来源行。 */
      expect(requestBody).toContain("来源任务：");
    } finally {
      await application.shutdown().catch(() => undefined);
    }
  }, 120_000);
});
