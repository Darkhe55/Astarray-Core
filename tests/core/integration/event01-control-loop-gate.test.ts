/**
 * EVENT-01 控制通道 ↔ 工具循环门禁（2026-10-24）。
 *
 * 证明生产门禁接缝可用：把 `EventControlChannel` 接到既有的 `workWindowGate`，
 * 未解除事故时**模型根本不被调用**（不烧 token）；低严重度事故不阻断执行。
 */
import { describe, expect, it } from "vitest";

import { runToolLoop } from "../../../packages/core/src/runtime/tool-loop.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRuntime, ToolCallResult, ToolPort } from "../../../packages/core/src/core/types.js";
import { EventControlChannel } from "../../../packages/core/src/orchestration/event-control-channel.js";

async function runWithEventGate(channel: EventControlChannel): Promise<{ modelRunCount: number; toolExecutionCount: number }> {
  let modelRunCount = 0;
  let toolExecutionCount = 0;
  const runtime: AgentRuntime = {
    async *run() {
      modelRunCount += 1;
      yield { kind: "runFinished", agentId: "agent-1", reason: "success", detail: "完成" };
    },
  } as never;
  const toolPort: ToolPort = {
    async execute(): Promise<ToolCallResult> {
      toolExecutionCount += 1;
      return { kind: "success", callId: "call-1", outputText: "done", isSideEffectFree: true };
    },
  };

  const nowIso = "2026-10-24T00:00:00.000Z";
  const stream = await runToolLoop(
    {
      missionId: "mission-1",
      agentId: "agent-1",
      systemPrompt: "system",
      userPrompt: "user",
      availableToolDescriptors: [],
      maxLoopIterations: 2,
    },
    {
      runtime,
      toolPort,
      maxLoopIterations: 2,
      cancellationSignal: new AbortController().signal,
      workWindowGate: async (request) => {
        const decision =
          request.gatePoint === "model"
            ? channel.beforeModelCall(nowIso)
            : channel.beforeToolCall(request.toolName ?? "", nowIso);
        if (decision.isAllowed) return { kind: "allow", reason: decision.reason };
        return {
          kind: "deny",
          reasonCode: "event-incident-active",
          reason: decision.reason,
        };
      },
    },
  );
  for await (const event of stream) {
    void (event as AgentEvent);
  }
  return { modelRunCount, toolExecutionCount };
}

describe("EVENT-01 控制通道 ↔ 工具循环门禁", () => {
  it("① 无事故 ⇒ 模型与工具照常执行", async () => {
    const channel = new EventControlChannel({ maximumConcurrentIncidents: 2, responseDeadlineSeconds: 60 });
    channel.registerToolCapabilities([{ toolName: "readFile", supportsCancellation: true }]);
    const result = await runWithEventGate(channel);
    expect(result.modelRunCount).toBe(1);
  });

  it("② 收到 critical 事故 ⇒ 模型调用被拦（模型请求计数为 0）", async () => {
    const channel = new EventControlChannel({ maximumConcurrentIncidents: 2, responseDeadlineSeconds: 60 });
    channel.receiveEvent({
      kind: "process-exit",
      resourceKey: "runtime-1",
      severity: "critical",
      epoch: 1,
      receivedAtIso: "2026-10-24T00:00:00.000Z",
    });
    const result = await runWithEventGate(channel);
    expect(result.modelRunCount).toBe(0);
  });

  it("③ 低严重度事故只记录、不阻断（避免普通错误把整轮停死）", async () => {
    const channel = new EventControlChannel({ maximumConcurrentIncidents: 2, responseDeadlineSeconds: 60 });
    channel.receiveEvent({
      kind: "tool-crash",
      resourceKey: "tool-1",
      severity: "low",
      epoch: 1,
      receivedAtIso: "2026-10-24T00:00:00.000Z",
    });
    const result = await runWithEventGate(channel);
    expect(result.modelRunCount).toBe(1);
  });
});
