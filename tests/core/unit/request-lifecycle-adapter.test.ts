/**
 * WIRING-04-02（2026-11-17）：适配器在**真实传输边界**发布生命周期事实。
 *
 * - 调用传输 API 前 ⇒ dispatched
 * - 拿到对端响应（含 HTTP 错误响应）⇒ acknowledged
 * - 已调用但拿不到响应（断网/超时）⇒ outcome-unknown
 * - 首事件、迭代器创建、runFinished 都**不**构成投递证据
 */
import { describe, expect, it } from "vitest";

import { OpenAiCompatibleRuntime } from "../../../packages/core/src/runtime/openai-compatible-runtime.js";
import type { RequestLifecycleEvent } from "../../../packages/core/src/core/types.js";

function buildRuntime(fetchImpl: typeof fetch) {
  return new OpenAiCompatibleRuntime({
    baseUrl: "http://127.0.0.1:1/v1/chat/completions",
    apiKey: "fake-key",
    model: "fake-model",
    maxTokens: 16,
    requestTimeoutMilliseconds: 1_000,
    fetchImpl,
  } as never);
}

const baseInput = {
  agentId: "worker-1",
  missionId: "mission-1",
  systemPrompt: "rules",
  userPrompt: "do it",
  availableToolDescriptors: [],
  maxLoopIterations: 1,
} as never;

async function collect(
  runtime: ReturnType<typeof buildRuntime>,
  events: RequestLifecycleEvent[],
): Promise<void> {
  const abortController = new AbortController();
  const stream = runtime.run(
    { ...(baseInput as object), requestLifecycleObserver: (event: RequestLifecycleEvent) => events.push(event) } as never,
    abortController.signal,
  );
  for await (const _event of stream) {
    void _event;
  }
}

describe("请求生命周期（适配器）", () => {
  it("① 正常响应：先 dispatched 再 acknowledged", async () => {
    const lifecycleEvents: RequestLifecycleEvent[] = [];
    const runtime = buildRuntime((async () => {
      return new Response("", { status: 200 }) as never;
    }) as never);
    await collect(runtime, lifecycleEvents).catch(() => undefined);
    expect(lifecycleEvents.map((event) => event.kind).slice(0, 2)).toEqual([
      "dispatched",
      "acknowledged",
    ]);
  }, 30_000);

  it("② HTTP 4xx 也是 acknowledged（对端作答 ≠ 业务成功）", async () => {
    const lifecycleEvents: RequestLifecycleEvent[] = [];
    const runtime = buildRuntime((async () => {
      return new Response("denied", { status: 403 }) as never;
    }) as never);
    await collect(runtime, lifecycleEvents).catch(() => undefined);
    expect(lifecycleEvents.map((event) => event.kind).slice(0, 2)).toEqual([
      "dispatched",
      "acknowledged",
    ]);
  }, 30_000);

  it("③ 传输层抛错 ⇒ dispatched 后 outcome-unknown（不是 delivered）", async () => {
    const lifecycleEvents: RequestLifecycleEvent[] = [];
    const runtime = buildRuntime((async () => {
      throw new Error("连接被重置");
    }) as never);
    await collect(runtime, lifecycleEvents).catch(() => undefined);
    expect(lifecycleEvents.map((event) => event.kind).slice(0, 2)).toEqual([
      "dispatched",
      "outcome-unknown",
    ]);
  }, 30_000);
});
