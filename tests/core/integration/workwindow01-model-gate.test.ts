/**
 * WORKWINDOW-01-02 **模型执行前**门禁反例（2026-10-20）。
 *
 * 关键断言：拒绝时 **`runtime.run` 一次都没被调用**（provider 调用计数 = 0）⇒ 不产生模型请求、不烧 token；
 * 放行时运行；未提供门禁时行为不变；入参 `gatePoint="model"`。
 */
import { describe, expect, it } from "vitest";

import { runToolLoop } from "../../../packages/core/src/runtime/tool-loop.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRuntime, ToolCallResult, ToolPort } from "../../../packages/core/src/core/types.js";

type GateDecision =
  | { readonly kind: "allow"; readonly reason: string }
  | {
      readonly kind: "deny";
      readonly reasonCode: string;
      readonly reason: string;
      readonly activePauseReasonKinds?: ReadonlyArray<string>;
    };

async function runWithModelGate(input: {
  gate?: (request: { gatePoint: "model" | "tool-execution"; toolName?: string }) => Promise<GateDecision>;
}): Promise<{ modelRunCount: number; events: AgentEvent[]; gatePoints: string[] }> {
  let modelRunCount = 0;
  const gatePoints: string[] = [];
  const runtime: AgentRuntime = {
    async *run() {
      modelRunCount += 1;
      yield { kind: "runFinished", agentId: "agent-1", reason: "success", detail: "完成" };
    },
  } as never;
  const toolPort: ToolPort = {
    async execute(): Promise<ToolCallResult> {
      return { kind: "success", callId: "call-1", outputText: "done", isSideEffectFree: true };
    },
  };

  const events: AgentEvent[] = [];
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
      ...(input.gate === undefined
        ? {}
        : {
            workWindowGate: async (request: { gatePoint: "model" | "tool-execution"; toolName?: string }) => {
              gatePoints.push(request.gatePoint);
              return await input.gate!(request);
            },
          }),
    },
  );
  for await (const event of stream) events.push(event);
  return { modelRunCount, events, gatePoints };
}

describe("WORKWINDOW-01-02 模型执行前门禁", () => {
  it("① 门禁拒绝 ⇒ runtime.run **一次都没被调用**（不产生模型请求）", async () => {
    const result = await runWithModelGate({
      gate: async () => ({
        kind: "deny",
        reasonCode: "resting",
        reason: "当前处于休息时段：不发起模型请求。",
        activePauseReasonKinds: ["user-paused"],
      }),
    });
    expect(result.modelRunCount).toBe(0);
  });

  it("② 拒绝原因写进 runFinished（含全部暂停原因）", async () => {
    const result = await runWithModelGate({
      gate: async () => ({
        kind: "deny",
        reasonCode: "paused",
        reason: "存在暂停原因。",
        activePauseReasonKinds: ["user-paused", "watchdog"],
      }),
    });
    const finished = result.events.find((event) => event.kind === "runFinished") as
      | { reason?: string; detail?: string }
      | undefined;
    expect(finished?.reason).toBe("error");
    expect(finished?.detail).toContain("模型执行被门禁拦截");
    expect(finished?.detail).toContain("user-paused");
    expect(finished?.detail).toContain("watchdog");
  });

  it("③ 门禁放行 ⇒ 模型真的被调用", async () => {
    const result = await runWithModelGate({ gate: async () => ({ kind: "allow", reason: "工作时段" }) });
    expect(result.modelRunCount).toBeGreaterThan(0);
  });

  it("④ 未提供门禁 ⇒ 行为不变（模型照常被调用）", async () => {
    const result = await runWithModelGate({});
    expect(result.modelRunCount).toBeGreaterThan(0);
  });

  it("⑤ 门禁入参：模型调用前先问 gatePoint=model", async () => {
    const result = await runWithModelGate({ gate: async () => ({ kind: "allow", reason: "工作时段" }) });
    expect(result.gatePoints[0]).toBe("model");
  });
});
