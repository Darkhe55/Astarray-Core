/**
 * HISTORY-01-02 端到端：**真实任务跑一次 ⇒ 运行历史文件真的出现**（2026-10-18 第 45 轮）。
 *
 * 手法：假 Provider 先返回一次 `tool_call`（触发工具执行），再返回完成标记；
 * 断言 `stateDirectory/run-history/<missionId>.json` 存在且含 `tool-call` 事件。
 *
 * 这条是"历史已生效"的唯一证据 —— 没有它，前面四层接线只算"代码就绪"。
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

let stateDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-history-e2e-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  // 不删临时目录（后台仍可能写盘，§14.3 教训）。
});

/** 先发一次 tool_call（factVerification），再发完成标记。 */
async function startToolCallingServer(taskExecutionId: string) {
  let responseCount = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      responseCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });

      if (responseCount === 1) {
        response.write(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tc-1",
                        function: {
                          name: "factVerification",
                          arguments: JSON.stringify({
                            action: "record-reasoning",
                            premises: ["p1"],
                            uncertainty: "medium",
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }) +
            "\n\n",
        );
        response.end();
        return;
      }

      response.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  content:
                    "ASTARRAY_TASK_COMPLETION_V1 " +
                    JSON.stringify({
                      taskExecutionId,
                      completionAttemptId: "attempt-" + Math.random().toString(16).slice(2),
                      completedTaskIdentifiers: ["T-001"],
                      claimedStatus: "complete",
                      taskSequenceRevision: 1,
                    }) +
                    "\n",
                },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\n",
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  runningServers.push(server);
  const address = server.address() as { port: number };
  return "http://127.0.0.1:" + String(address.port) + "/v1/chat/completions";
}

describe("HISTORY-01-02 端到端：真实任务产生运行历史", () => {
  it("① 工具调用后 ⇒ run-history 文件出现且含 tool-call 事件", async () => {
    const endpoint = await startToolCallingServer("task-exec:history-1");

    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        readCredential: async () => ({ baseUrl: endpoint, apiKey: "fake-key" }),
      },
    });
    registry.register(createOpenAiCompatibleProviderRegistration());

    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "devolve",
      runtime: "provider",
      useFeedbackProcess: false,
      providerRuntimeRegistry: registry,
      maximumLoopIterations: 4,
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
    } as unknown as Parameters<typeof AstarrayApplicationFacade.create>[0]);

    application.createSession({ sessionId: "session-1", mode: "devolve" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "T-001",
      prompt: "用事实核查工具记录一次推理",
    });

    let result = await application.queryTask({ sessionId: "session-1", taskIdentifier: "T-001" });
    const deadline = Date.now() + 60_000;
    while (
      !["done", "failed", "blocked", "cancelled"].includes(result.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await application.queryTask({ sessionId: "session-1", taskIdentifier: "T-001" });
    }
    await application.shutdown();

    // 关键断言：历史文件真的存在
    const runHistoryDirectory = path.join(stateDirectory, "run-history");
    const historyFiles = await fs.readdir(runHistoryDirectory).catch(() => [] as string[]);
    expect(historyFiles.length).toBeGreaterThan(0);

    const historyContent = await fs.readFile(
      path.join(runHistoryDirectory, historyFiles[0] as string),
      "utf8",
    );
    expect(historyContent).toContain("tool-call");
    expect(historyContent).toContain("factVerification");
  });
});
