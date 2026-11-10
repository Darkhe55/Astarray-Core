/**
 * AUDIT-REPAIR-01 检查点 02（2026-11-06）：fake-server 驱动真实运行时 + ToolLoop，
 * 断言所有失败路径都**不执行任何工具**（执行计数为 0）。
 */
import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicMessagesRuntime } from "../../../packages/core/src/runtime/anthropic-messages-runtime.js";
import { runToolLoop } from "../../../packages/core/src/runtime/tool-loop.js";
import type { AgentRunInput, ToolDescriptor } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 60_000 });

const servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function sse(payload: unknown): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

async function startServer(options: {
  chunks: string[];
  holdAfterChunks?: boolean;
}): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of options.chunks) {
      response.write(chunk);
    }
    if (options.holdAfterChunks === true) {
      // 保持连接不结束，用于超时/取消
      setTimeout(() => response.end(), 5_000).unref();
      return;
    }
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return "http://127.0.0.1:" + String(port) + "/anthropic/v1/messages";
}

const toolDescriptor: ToolDescriptor = {
  name: "createProjectFile",
  summary: "新建项目文件",
  category: "restricted",
  mutationKind: "create-only",
  backupPolicy: "not-required",
  authorizationPolicy: "standard",
  supportedTaskTypes: ["data"],
  isIdempotent: true,
  inputSchema: { type: "object" },
};

function buildInput(): AgentRunInput {
  return {
    missionId: "mission-failclosed",
    agentId: "worker:mission-failclosed:T-001",
    systemPrompt: "系统",
    userPrompt: "创建文件",
    availableToolDescriptors: [toolDescriptor],
    maxLoopIterations: 2,
  };
}

async function runWithCounter(input: {
  baseUrl: string;
  requestTimeoutMilliseconds?: number;
  signal?: AbortSignal;
}): Promise<{ outcome: "events" | "rejected"; error?: unknown }> {
  const execute = vi.fn(async (_toolName: string, _argumentsJson: string, callId: string) => ({
    kind: "success" as const,
    callId,
    outputText: "ok",
    isSideEffectFree: false,
  }));
  const runtime = new AnthropicMessagesRuntime({
    baseUrl: input.baseUrl,
    apiKey: "test-key",
    model: "m",
    requestTimeoutMilliseconds: input.requestTimeoutMilliseconds ?? 5_000,
  });
  const cancellationSignal = input.signal ?? new AbortController().signal;
  try {
    const stream = await runToolLoop(buildInput(), {
      runtime,
      toolPort: { execute },
      maxLoopIterations: 2,
      cancellationSignal,
    });
    for await (const event of stream) {
      void event;
    }
    return { outcome: "events" };
  } catch (error) {
    return { outcome: "rejected", error };
  } finally {
    expect(execute).toHaveBeenCalledTimes(0);
  }
}

function toolStart(id = "toolu_1", index = 0): string {
  return sse({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name: "createProjectFile" },
  });
}

function toolDelta(index = 0, partial = '{"filePath":"a"}', id = "toolu_1"): string {
  void id;
  return sse({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partial },
  });
}

describe("AUDIT-REPAIR-01：失败路径工具执行计数为 0", () => {
  it("部分工具后 error 事件", async () => {
    const baseUrl = await startServer({
      chunks: [
        sse({ type: "message_start" }),
        toolStart(),
        toolDelta(),
        sse({ type: "error", error: { type: "overloaded_error" } }),
      ],
    });
    const result = await runWithCounter({ baseUrl });
    expect(result.outcome).toBe("rejected");
  });

  it("完整工具后 error 事件", async () => {
    const baseUrl = await startServer({
      chunks: [
        sse({ type: "message_start" }),
        toolStart(),
        toolDelta(),
        sse({ type: "content_block_stop", index: 0 }),
        sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
        sse({ type: "error", error: { type: "api_error" } }),
      ],
    });
    const result = await runWithCounter({ baseUrl });
    expect(result.outcome).toBe("rejected");
  });

  it("截断（EOF 缺 message_stop）", async () => {
    const baseUrl = await startServer({
      chunks: [
        sse({ type: "message_start" }),
        toolStart(),
        toolDelta(),
        sse({ type: "content_block_stop", index: 0 }),
        sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      ],
    });
    const result = await runWithCounter({ baseUrl });
    expect(result.outcome).toBe("rejected");
  });

  it("max_tokens 与重复 ID", async () => {
    const maxTokens = await startServer({
      chunks: [
        sse({ type: "message_start" }),
        toolStart(),
        toolDelta(),
        sse({ type: "content_block_stop", index: 0 }),
        sse({ type: "message_delta", delta: { stop_reason: "max_tokens" } }),
        sse({ type: "message_stop" }),
      ],
    });
    expect((await runWithCounter({ baseUrl: maxTokens })).outcome).toBe("rejected");

    const duplicate = await startServer({
      chunks: [
        sse({ type: "message_start" }),
        toolStart("same", 0),
        toolDelta(0),
        sse({ type: "content_block_stop", index: 0 }),
        toolStart("same", 1),
        toolDelta(1),
        sse({ type: "content_block_stop", index: 1 }),
        sse({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
        sse({ type: "message_stop" }),
      ],
    });
    expect((await runWithCounter({ baseUrl: duplicate })).outcome).toBe("rejected");
  });

  it("非法 JSON 数据事件 ⇒ 明确协议错误（不得静默丢弃）", async () => {
    const baseUrl = await startServer({
      chunks: ["data: {not-json}\n\n", sse({ type: "message_stop" })],
    });
    const result = await runWithCounter({ baseUrl });
    expect(result.outcome).toBe("rejected");
    const message = String((result.error as Error).message ?? "");
    expect(message.toLowerCase()).toMatch(/json|协议|protocol/u);
  });

  it("超时与取消：都不执行工具", async () => {
    const timeoutUrl = await startServer({
      chunks: [sse({ type: "message_start" })],
      holdAfterChunks: true,
    });
    const timedOut = await runWithCounter({
      baseUrl: timeoutUrl,
      requestTimeoutMilliseconds: 100,
    });
    expect(timedOut.outcome).toBe("rejected");
    expect((timedOut.error as { errorCode?: string }).errorCode).toBe("provider-timeout");

    const cancelUrl = await startServer({
      chunks: [sse({ type: "message_start" })],
      holdAfterChunks: true,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const cancelled = await runWithCounter({
      baseUrl: cancelUrl,
      requestTimeoutMilliseconds: 5_000,
      signal: controller.signal,
    });
    expect(cancelled.outcome).toBe("events");
  });
});