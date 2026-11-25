/**
 * WIRING-04 整链（生产入口）：任务映射 → 固定版本包 → **真实 provider 请求载荷**。
 *
 * 2026-11-25 用户裁决方案 ③：新增 `onMissionPrepared` 钩子（任务创建后、首次 provider 请求前），
 * 测试用它拿到**真实 mission 标识**再播种精确映射与序列包；生产缺省不调用。
 *
 * 断言：本地假 Provider 收到的请求体里选定正文**只出现一次**，且带 `[上下文包]` 区块。
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000 });

import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { MissionTaskSequenceMapStore } from "../../../packages/core/src/orchestration/mission-task-sequence-map-store.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAiCompatibleProviderRegistration,
} from "../../../packages/core/src/runtime/openai-compatible-provider-registration.js";
import { ProviderRuntimeRegistry } from "../../../packages/core/src/runtime/provider-runtime-registry.js";

let stateDirectory: string;
const runningServers: http.Server[] = [];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-wiring04-e2e-"));
});

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("WIRING-04 整链：映射→包→真实请求载荷", () => {
  it("选定正文只在请求体出现一次，并带 [上下文包] 区块", async () => {
    const receivedBodies: string[] = [];
    const server = http.createServer((request, response) => {
      let rawBody = "";
      request.on("data", (chunk) => {
        rawBody += String(chunk);
      });
      request.on("end", () => {
        receivedBodies.push(rawBody);
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
                        taskExecutionId: "task-exec:wiring04",
                        completionAttemptId: "attempt-wiring04",
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
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    runningServers.push(server);
    const address = server.address() as { port: number };
    const endpoint = "http://127.0.0.1:" + address.port + "/v1/chat/completions";

    const UNIQUE_PACK_TEXT = "选定正文-唯一标记-WIRING04-E2E";
    const sequenceStore = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
    const mapStore = new MissionTaskSequenceMapStore({ baseDirectory: stateDirectory });
    const preparedObservations: string[] = [];

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
        requiredCapabilities: ["streaming"],
        baseUrl: endpoint,
        protectedCredentialReferenceId: "cred-1",
        requestTimeoutMilliseconds: 5_000,
      },
      statusPollIntervalMilliseconds: 10,
      onMissionPrepared: async (observation) => {
        preparedObservations.push(observation.missionIdentifier);
        if (
          observation.taskSequenceIdentifier === null ||
          observation.sequenceOwnerAgentInstanceIdentifier === null
        ) {
          throw new Error("assist 路径应已登记任务序列");
        }
        const existing = await sequenceStore.readSequence(
          observation.sequenceOwnerAgentInstanceIdentifier,
          observation.taskSequenceIdentifier,
        );
        if (existing === null) throw new Error("序列文档不存在");
        const targetNode = existing.nodes[0];
        if (targetNode === undefined) throw new Error("序列没有节点");
        await sequenceStore.writeSequenceDirect({
          ...existing,
          revision: existing.revision + 1,
          updatedAtIso: "2026-11-25T00:00:00.000Z",
          nodes: existing.nodes.map((node, index) =>
            index === 0
              ? {
                  ...node,
                  contextPack: {
                    packIdentifier: "pack-wiring04",
                    mergePolicy: "atomic" as const,
                    sourcePriority: "user" as const,
                    members: [
                      {
                        memberIdentifier: "member-1",
                        sourceKind: "user" as const,
                        summary: UNIQUE_PACK_TEXT,
                        contentFingerprint: "sha256:member-1",
                      },
                    ],
                  },
                }
              : node,
          ),
        } as never);
        await mapStore.bind({
          missionIdentifier: observation.missionIdentifier,
          sequenceIdentifier: observation.taskSequenceIdentifier,
          ownerAgentInstanceIdentifier: observation.sequenceOwnerAgentInstanceIdentifier,
          missionTaskIdentifier: observation.taskIdentifiers[0] ?? "",
          sequenceTaskIdentifier: targetNode.taskId,
        });
      },
    });

    application.createSession({ sessionId: "session-1", mode: "assist" });
    await application.submitTask({
      sessionId: "session-1",
      taskIdentifier: "task-1",
      prompt: "WIRING-04 整链探针",
    });

    const deadline = Date.now() + 60_000;
    let status = "accepted";
    while (Date.now() < deadline && !["done", "failed", "blocked", "cancelled"].includes(status)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (await application.queryTask({ sessionId: "session-1", taskIdentifier: "task-1" }))
        .status;
    }
    await application.shutdown();

    expect(preparedObservations.length).toBeGreaterThan(0);
    expect(status).toBe("done");
    expect(receivedBodies.length).toBeGreaterThan(0);
    const requestBody = receivedBodies[0] ?? "";
    expect(requestBody).toContain("[上下文包]");
    const occurrences = requestBody.split(UNIQUE_PACK_TEXT).length - 1;
    expect(occurrences).toBe(1);
  });
});
