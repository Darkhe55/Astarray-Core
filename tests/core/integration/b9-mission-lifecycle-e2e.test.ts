/**
 * B9（2026-11-25）：mission 生命周期 E2E（成功 / 失败 / 取消）。
 *
 * 目的：一次穿透 facade → orchestrator → runtime → provider 适配器，
 * 比逐个参数校验分支更能覆盖 `main-controller` / `application-runtime` / `public-sdk`。
 *
 * 全部使用本地假 Provider：不出网、不付费。
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

let stateDirectory: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lifecycle-"));
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function startServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<string> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => handler(request, response, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + String(address.port) + "/v1/chat/completions";
}

async function createFacade(endpoint: string): Promise<AstarrayApplicationFacade> {
  const registry = new ProviderRuntimeRegistry({
    protectedCredentialStore: {
      doesReferenceExist: async () => true,
      readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
    },
  });
  registry.register(createOpenAiCompatibleProviderRegistration());
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "provider",
    useFeedbackProcess: false,
    providerRuntimeRegistry: registry,
    provider: {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelIdentifier: "fake-model",
      allowedModelIdentifiers: ["fake-model"],
      requiredCapabilities: ["streaming"],
      baseUrl: endpoint,
      protectedCredentialReferenceId: "cred-1",
      requestTimeoutMilliseconds: 3_000,
    },
    statusPollIntervalMilliseconds: 10,
  });
}

async function waitForTerminal(
  application: AstarrayApplicationFacade,
  sessionId: string,
  taskIdentifier: string,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  let status = "accepted";
  while (Date.now() < deadline && !["done", "failed", "blocked", "cancelled"].includes(status)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (await application.queryTask({ sessionId, taskIdentifier })).status;
  }
  return status;
}

function completionSse(): void {
  void 0;
}

describe("B9：mission 生命周期 E2E", () => {
  it("① 成功路径：provider 返回完成标记 ⇒ task done", async () => {
    const endpoint = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  content:
                    "已完成。\nASTARRAY_TASK_COMPLETION_V1 " +
                    JSON.stringify({
                      taskExecutionId: "task-exec:lifecycle-ok",
                      completionAttemptId: "attempt-ok",
                      completedTaskIdentifiers: ["T-001"],
                      claimedStatus: "complete",
                      taskSequenceRevision: 1,
                    }),
                },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\n",
      );
      response.end();
    });
    const application = await createFacade(endpoint);
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-ok",
      prompt: "成功路径",
    });
    const status = await waitForTerminal(application, "session-1", "task-ok");
    await application.shutdown();
    expect(status).toBe("done");
  });

  it("② 失败路径：provider 返回 500 ⇒ 不判 done", async () => {
    const endpoint = await startServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    });
    const application = await createFacade(endpoint);
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-fail",
      prompt: "失败路径",
    });
    const status = await waitForTerminal(application, "session-1", "task-fail");
    await application.shutdown();
    expect(status).not.toBe("done");
  });

  it("③ 取消路径：请求未返回时取消 ⇒ cancelled 且不判 done", async () => {
    const endpoint = await startServer((_request, response) => {
      /** 故意延迟，留出取消窗口。 */
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: {}\n\n");
      }, 2_000);
    });
    const application = await createFacade(endpoint);
    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-cancel",
      prompt: "取消路径",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await application.cancelTask({ sessionId: "session-1", taskIdentifier: "task-cancel" });
    const status = await waitForTerminal(application, "session-1", "task-cancel");
    await application.shutdown();
    expect(status).toBe("cancelled");
    completionSse();
  });
});
