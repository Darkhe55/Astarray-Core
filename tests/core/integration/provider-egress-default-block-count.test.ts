/**
 * RELEASE-01-02（2026-11-23）：**两协议"零网络请求"计数验收**。
 *
 * 用注入的 `fetchImpl` 计数：默认 `block` 下，敏感/扫描未完成的请求体**不得发起任何请求**；
 * 干净请求照常发一次；显式 `record`（隔离诊断）仍发送并只记审计。
 */
import { describe, expect, it } from "vitest";

import type { AgentRunInput } from "../../../packages/core/src/core/types.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import { AnthropicMessagesRuntime } from "../../../packages/core/src/runtime/anthropic-messages-runtime.js";
import { OpenAiCompatibleRuntime } from "../../../packages/core/src/runtime/openai-compatible-runtime.js";
import { clearProviderEgressScanRecords } from "../../../packages/core/src/runtime/provider-egress-scan.js";

const FAKE_TOKEN = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

function baseRunInput(userPrompt: string): AgentRunInput {
  return {
    missionId: "mission-egress",
    agentId: "worker:mission-egress:T-001:1",
    systemPrompt: "系统提示",
    userPrompt,
    availableToolDescriptors: [],
    maxLoopIterations: 1,
  };
}

interface CountingFetch {
  readonly fetchImpl: typeof fetch;
  readonly count: () => number;
}

function countingFetch(): CountingFetch {
  let requests = 0;
  return {
    count: () => requests,
    fetchImpl: (async () => {
      requests += 1;
      /** 最小响应：只关心"是否发生请求"；解析失败在断言中不算请求。 */
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch,
  };
}

async function drain(runtime: { run: (input: AgentRunInput, signal: AbortSignal) => AsyncIterable<AgentEvent> }, input: AgentRunInput): Promise<void> {
  for await (const event of runtime.run(input, new AbortController().signal)) {
    void event; /* 事件内容不由本用例断言 */
  }
}

const RUNNERS = [
  {
    name: "openai-compatible",
    create: (fetchImpl: typeof fetch, egressScanMode?: "record") =>
      new OpenAiCompatibleRuntime({
        baseUrl: "https://example.invalid/v1/chat/completions",
        apiKey: "test-key",
        model: "fake-model",
        requestTimeoutMilliseconds: 5_000,
        fetchImpl,
        ...(egressScanMode === undefined ? {} : { egressScanMode }),
      }),
  },
  {
    name: "anthropic-messages",
    create: (fetchImpl: typeof fetch, egressScanMode?: "record") =>
      new AnthropicMessagesRuntime({
        baseUrl: "https://example.invalid/v1/messages",
        apiKey: "test-key",
        model: "fake-model",
        requestTimeoutMilliseconds: 5_000,
        fetchImpl,
        ...(egressScanMode === undefined ? {} : { egressScanMode }),
      }),
  },
] as const;

describe.each(RUNNERS)("RELEASE-01-02：$name 零网络请求计数", ({ create }) => {
  it("① 敏感请求体 ⇒ 默认 block：抛错且零请求", async () => {
    clearProviderEgressScanRecords();
    const counter = countingFetch();
    const runtime = create(counter.fetchImpl);
    await expect(
      drain(runtime as never, baseRunInput(`配置：${FAKE_TOKEN}`)),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
    expect(counter.count()).toBe(0);
  });

  it("② 扫描未完成（超大请求体）⇒ 默认 block：零请求", async () => {
    clearProviderEgressScanRecords();
    const counter = countingFetch();
    const runtime = create(counter.fetchImpl);
    const hugePrompt = "普通文本。".repeat(300_000);
    await expect(
      drain(runtime as never, baseRunInput(hugePrompt)),
    ).rejects.toMatchObject({ errorCode: "sensitive-content-read-denied" });
    expect(counter.count()).toBe(0);
  });

  it("③ 干净请求体 ⇒ 正常发起一次请求", async () => {
    clearProviderEgressScanRecords();
    const counter = countingFetch();
    const runtime = create(counter.fetchImpl);
    await drain(runtime as never, baseRunInput("请总结这份文档")).catch(() => undefined);
    expect(counter.count()).toBe(1);
  });

  it("④ 显式 record（隔离诊断）⇒ 敏感请求体仍发送，只记录", async () => {
    clearProviderEgressScanRecords();
    const counter = countingFetch();
    const runtime = create(counter.fetchImpl, "record");
    await drain(runtime as never, baseRunInput(`配置：${FAKE_TOKEN}`)).catch(() => undefined);
    expect(counter.count()).toBe(1);
  });
});
