/**
 * B9（2026-11-24）：Anthropic 运行时的协议/参数边界。
 *
 * 纪律：工具调用缺少 id/名称/参数或参数不是 JSON 对象时必须**整批拒绝**，
 * 不允许执行任何工具；SSE 注释、多行 data、结尾无换行也要正确处理。
 */
import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicMessagesRuntime } from "../../../packages/core/src/runtime/anthropic-messages-runtime.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
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

async function startServer(rawBody: string): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(rawBody);
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
    missionId: "mission-anthropic-branches",
    agentId: "worker:mission-anthropic-branches:T-001",
    systemPrompt: "系统",
    userPrompt: "创建文件",
    availableToolDescriptors: [toolDescriptor],
    maxLoopIterations: 2,
  };
}

async function collect(baseUrl: string): Promise<AgentEvent[]> {
  const runtime = new AnthropicMessagesRuntime({
    baseUrl,
    apiKey: "test-key",
    model: "m",
    requestTimeoutMilliseconds: 5_000,
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.run(buildInput(), new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

function messageStart(): string {
  return sse({
    type: "message_start",
    message: { id: "msg_1", role: "assistant", usage: { input_tokens: 1 } },
  });
}

function toolUseStart(input: { id: string; name: string }): string {
  return sse({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: input.id, name: input.name },
  });
}

function deltaStop(reason = "end_turn"): string {
  return sse({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 1 } });
}

describe("B9：Anthropic 协议边界", () => {
  it("① 工具调用缺少 id ⇒ 整批拒绝（provider-protocol-error）", async () => {
    const endpoint = await startServer(messageStart() + toolUseStart({ id: "", name: "createProjectFile" }) + deltaStop("tool_use") + sse({ type: "message_stop" }));
    await expect(collect(endpoint)).rejects.toMatchObject({ errorCode: "provider-protocol-error" });
  });

  it("② 工具调用缺少名称 ⇒ 整批拒绝", async () => {
    const endpoint = await startServer(messageStart() + toolUseStart({ id: "call-1", name: "" }) + deltaStop("tool_use") + sse({ type: "message_stop" }));
    await expect(collect(endpoint)).rejects.toMatchObject({ errorCode: "provider-protocol-error" });
  });

  it("③ 工具调用缺少参数 ⇒ 整批拒绝（不伪造空对象）", async () => {
    const endpoint = await startServer(
      messageStart() +
        toolUseStart({ id: "call-1", name: "createProjectFile" }) +
        sse({ type: "content_block_stop", index: 0 }) +
        deltaStop("tool_use") +
        sse({ type: "message_stop" }),
    );
    await expect(collect(endpoint)).rejects.toThrowError(/缺少参数/);
  });

  it("④ 参数不是 JSON 对象（数组）⇒ 整批拒绝", async () => {
    const endpoint = await startServer(
      messageStart() +
        toolUseStart({ id: "call-1", name: "createProjectFile" }) +
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "[]" },
        }) +
        deltaStop("tool_use") +
        sse({ type: "message_stop" }),
    );
    await expect(collect(endpoint)).rejects.toMatchObject({ errorCode: "provider-protocol-error" });
  });

  it("⑤ 参数不是合法 JSON ⇒ 整批拒绝", async () => {
    const endpoint = await startServer(
      messageStart() +
        toolUseStart({ id: "call-1", name: "createProjectFile" }) +
        sse({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{ broken" },
        }) +
        sse({ type: "content_block_stop", index: 0 }) +
        deltaStop("tool_use") +
        sse({ type: "message_stop" }),
    );
    await expect(collect(endpoint)).rejects.toThrowError(/参数/);
  });

  it("⑥ SSE 注释/事件字段与多行 data 被正确忽略/拼接", async () => {
    const payload = JSON.stringify({ type: "message_stop" });
    const endpoint = await startServer(
      ": heartbeat\n" +
        "event: message\ndata: " +
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
        "\n\n" +
        "data: " +
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
        "\n\n" +
        "data: " +
        payload +
        "\n\n",
    );
    const events = await collect(endpoint);
    expect(events.at(-1)).toMatchObject({ kind: "runFinished" });
  });

  it("⑦ 结尾事件没有换行也能被解析（flush 残留）", async () => {
    const endpoint = await startServer(
      "data: " +
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } }) +
        "\n\ndata: " +
        JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }) +
        "\n\ndata: " +
        JSON.stringify({ type: "message_stop" }),
    );
    const events = await collect(endpoint);
    expect(events.at(-1)).toMatchObject({ kind: "runFinished" });
  });
});
