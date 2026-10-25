/** 模型能力进入运行时（2026-10-25）：最大输出映射为 provider max_tokens。 */
import { describe, expect, it } from "vitest";

import type { AgentRunInput } from "../../../packages/core/src/core/types.js";
import { OpenAiCompatibleRuntime } from "../../../packages/core/src/runtime/openai-compatible-runtime.js";

const runInput: AgentRunInput = {
  missionId: "mission-max-output",
  agentId: "worker:mission-max-output:T-001:1",
  systemPrompt: "系统提示",
  userPrompt: "任务",
  availableToolDescriptors: [],
  maxLoopIterations: 4,
};

async function captureBody(maxTokens?: number): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const runtime = new OpenAiCompatibleRuntime({
    baseUrl: "https://example.invalid/v1/chat/completions",
    apiKey: "test-key-not-a-real-secret",
    model: "test-model",
    requestTimeoutMilliseconds: 5_000,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    fetchImpl: (async (_url: string, init: { body?: string }) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch,
  });
  for await (const event of runtime.run(runInput, new AbortController().signal)) {
    void event;
  }
  return body;
}

describe("Provider 最大输出", () => {
  it("① 配置 maxTokens ⇒ 请求体带 max_tokens，且值为模型能力", async () => {
    expect((await captureBody(1234)).max_tokens).toBe(1234);
  });

  it("② 未配置 maxTokens ⇒ 不下发 max_tokens（不擅自改变默认行为）", async () => {
    expect((await captureBody()).max_tokens).toBeUndefined();
  });
});


