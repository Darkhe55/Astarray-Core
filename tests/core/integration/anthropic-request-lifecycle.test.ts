/**
 * WIRING-04-02 补口（2026-11-25）：Anthropic Messages 运行时的**请求生命周期事实**。
 *
 * 纪律：只有真实传输边界能发 dispatched/acknowledged/outcome-unknown；
 * 本地门禁拒绝 ⇒ failed-before-dispatch；HTTP 4xx/5xx 也是 acknowledged（对端作答≠业务成功）。
 */
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import type { AgentRunInput, RequestLifecycleEvent } from "../../../packages/core/src/core/types.js";
import { AnthropicMessagesRuntime } from "../../../packages/core/src/runtime/anthropic-messages-runtime.js";

function buildRunInput(observer: (event: RequestLifecycleEvent) => void): AgentRunInput {
  return {
    agentId: "agent-1",
    missionId: "mission-1",
    systemPrompt: "system",
    userPrompt: "hello",
    availableToolDescriptors: [],
    maxLoopIterations: 1,
    requestLifecycleObserver: observer,
  } as unknown as AgentRunInput;
}

function sseResponse(events: readonly string[]): Response {
  const body = events.join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(runtime: AnthropicMessagesRuntime, input: AgentRunInput): Promise<unknown[]> {
  const events: unknown[] = [];
  try {
    for await (const event of runtime.run(input, new AbortController().signal)) {
      events.push(event);
    }
  } catch (error) {
    events.push({ thrown: (error as Error).message });
  }
  return events;
}

describe("WIRING-04-02 anthropic 请求生命周期", () => {
  it("① 成功路径：dispatched → acknowledged（按顺序，各一次）", async () => {
    const lifecycle: RequestLifecycleEvent[] = [];
    const runtime = new AnthropicMessagesRuntime({
      baseUrl: "http://127.0.0.1:1/messages",
      apiKey: "test-key",
      model: "claude-test",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: async () =>
        sseResponse([
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
    });
    await collect(runtime, buildRunInput((event) => lifecycle.push(event)));
    expect(lifecycle.map((event) => event.kind)).toEqual(["dispatched", "acknowledged"]);
    expect(lifecycle.every((event) => event.requestIdentifier !== null)).toBe(true);
  });

  it("② HTTP 500 ⇒ acknowledged 后抛错（对端作答≠成功）", async () => {
    const lifecycle: RequestLifecycleEvent[] = [];
    const runtime = new AnthropicMessagesRuntime({
      baseUrl: "http://127.0.0.1:1/messages",
      apiKey: "test-key",
      model: "claude-test",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: async () => new Response("oops", { status: 500 }),
    });
    const events = await collect(runtime, buildRunInput((event) => lifecycle.push(event)));
    expect(lifecycle.map((event) => event.kind)).toEqual(["dispatched", "acknowledged"]);
    expect(events.some((event) => "thrown" in (event as object))).toBe(true);
  });

  it("③ 传输层抛错（断网）⇒ dispatched + outcome-unknown，不伪造 acknowledged", async () => {
    const lifecycle: RequestLifecycleEvent[] = [];
    const runtime = new AnthropicMessagesRuntime({
      baseUrl: "http://127.0.0.1:1/messages",
      apiKey: "test-key",
      model: "claude-test",
      requestTimeoutMilliseconds: 5_000,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await collect(runtime, buildRunInput((event) => lifecycle.push(event)));
    expect(lifecycle.map((event) => event.kind)).toEqual(["dispatched", "outcome-unknown"]);
    expect(lifecycle.some((event) => event.kind === "acknowledged")).toBe(false);
  });

  it("④ 出口扫描拦截 ⇒ failed-before-dispatch，且绝不调用传输", async () => {
    const lifecycle: RequestLifecycleEvent[] = [];
    const fetchImpl = vi.fn(async () => sseResponse([]));
    const runtime = new AnthropicMessagesRuntime({
      baseUrl: "http://127.0.0.1:1/messages",
      apiKey: "test-key",
      model: "claude-test",
      requestTimeoutMilliseconds: 5_000,
      egressScanMode: "block",
      fetchImpl,
    });
    const input = buildRunInput((event) => lifecycle.push(event));
    (input as unknown as { userPrompt: string }).userPrompt = "token=sk-ant-abcdefghijklmnop";
    await collect(runtime, input);
    expect(lifecycle.map((event) => event.kind)).toEqual(["failed-before-dispatch"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
