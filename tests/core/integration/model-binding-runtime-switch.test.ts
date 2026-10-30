/** GUI-03 / 方案 A：模型绑定在下一 mission 使用对应 runtime。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AstarrayApplicationFacade,
  ProviderRuntimeRegistry,
} from "../../../packages/core/src/public-sdk.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("模型绑定切换", () => {
  it("① application 绑定在下一 mission 使用新 runtime", async () => {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-switch-"));
    directories.push(stateDirectory);
    const resolvedModels: string[] = [];
    const registry = new ProviderRuntimeRegistry({
      protectedCredentialStore: {
        doesReferenceExist: async () => true,
        readCredential: async () => ({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "fake" }),
      },
    });
    registry.register({
      providerId: "fake-provider",
      protocol: "fake",
      protocolVersion: "1",
      supportedCapabilities: ["streaming", "tool-calling"],
      createRuntime: (config) => {
        resolvedModels.push(config.modelIdentifier);
        return {
          async *run() {
            yield { type: "text", text: "ok" };
            yield { type: "finish", reason: "success", detail: "完成" };
          },
        } as never;
      },
    });
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "provider",
      providerRuntimeRegistry: registry,
      provider: {
        providerId: "fake-provider",
        modelIdentifier: "model-a",
        allowedModelIdentifiers: ["model-a", "model-b"],
        requiredCapabilities: ["tool-calling"],
        baseUrl: "http://127.0.0.1:9/v1",
        protectedCredentialReferenceId: "cred",
      },
      modelConfigurations: [
        {
          providerId: "fake-provider",
          modelIdentifier: "model-b",
          baseUrl: "http://127.0.0.1:9/v1",
          protectedCredentialReferenceId: "cred",
          requestTimeoutMilliseconds: 1_000,
          allowedModelIdentifiers: ["model-a", "model-b"],
        },
      ],
      useFeedbackProcess: false,
      maximumLoopIterations: 2,
      isConversationMode: true,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      await application.setAgentModelBinding({
        scope: "session",
        scopeIdentifier: "session-1",
        providerId: "fake-provider",
        modelIdentifier: "model-b",
        expectedRevision: 1,
      });
      await application.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "使用绑定模型",
      });
      /**
       * R68（2026-10-30）：**轮询可观察结果**，不再固定等 20ms。
       *
       * 原写法在并行满载时会在 mission 还没创建 runtime 前断言 ⇒ 偶发失败（单独跑必过）。
       * 断言本身没有放宽：仍然要求 `model-b` 被真正解析，且绑定记录了 mission。
       */
      const deadline = Date.now() + 10_000;
      let observedModelB = false;
      let observedAppliedMission = false;
      while (Date.now() < deadline && !(observedModelB && observedAppliedMission)) {
        observedModelB = resolvedModels.includes("model-b");
        if (observedModelB) {
          const bindings = await application.queryAgentModelBindings();
          observedAppliedMission = Boolean(
            bindings.bindings["session:session-1"]?.lastAppliedMissionId,
          );
        }
        if (!observedModelB || !observedAppliedMission) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      expect(resolvedModels).toContain("model-b");
      const finalBindings = await application.queryAgentModelBindings();
      expect(finalBindings.bindings["session:session-1"]?.lastAppliedMissionId).toBeTruthy();
    } finally {
      await application.shutdown();
    }
  }, 20_000);
});

