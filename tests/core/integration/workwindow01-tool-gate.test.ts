/**
 * WORKWINDOW-01-02 **工具执行前**门禁反例（2026-10-20）。
 *
 * 用真实 `runToolLoop`（不复制逻辑）：
 * - 门禁拒绝 ⇒ `toolPort.execute` **一次都没被调用**，结果 `errorCode=work-window-gate-denied`，含全部暂停原因；
 * - 门禁放行 ⇒ 工具真的执行；
 * - 未提供门禁 ⇒ 行为不变（工具照常执行）；
 * - 门禁入参正确（toolName / gatePoint=tool-execution）。
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

function buildRuntime(): AgentRuntime {
  let callIssued = false;
  return {
    async *run() {
      if (!callIssued) {
        callIssued = true;
        yield { kind: "toolCallRequested", callId: "call-1", toolName: "write-file", argumentsJson: "{}" };
        yield { kind: "runFinished", agentId: "agent-1", reason: "tool-calls", detail: "需要工具" };
        return;
      }
      yield { kind: "runFinished", agentId: "agent-1", reason: "success", detail: "完成" };
    },
  } as never;
}

async function runWithGate(input: {
  gate?: (request: { toolName: string; gatePoint: "tool-execution" }) => Promise<GateDecision>;
}): Promise<{ executeCount: number; toolErrorCodes: string[]; events: AgentEvent[]; gateInputs: Array<{ toolName: string; gatePoint: string }> }> {
  let executeCount = 0;
  const gateInputs: Array<{ toolName: string; gatePoint: string }> = [];
  const toolPort: ToolPort = {
    async execute(): Promise<ToolCallResult> {
      executeCount += 1;
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
      runtime: buildRuntime(),
      toolPort,
      maxLoopIterations: 2,
      cancellationSignal: new AbortController().signal,
      ...(input.gate === undefined
        ? {}
        : {
            workWindowGate: async (request: { toolName: string; gatePoint: "tool-execution" }) => {
              gateInputs.push({ toolName: request.toolName, gatePoint: request.gatePoint });
              return await input.gate!(request);
            },
          }),
    },
  );
  for await (const event of stream) events.push(event);
  const toolErrorCodes = events
    .filter((event) => event.kind === "toolCallFinished")
    .map((event) => String((event as { errorCode?: string }).errorCode ?? ""));
  return { executeCount, toolErrorCodes, events, gateInputs };
}

describe("WORKWINDOW-01-02 工具执行前门禁", () => {
  it("① 门禁拒绝 ⇒ 工具**一次都没执行**，结果带 work-window-gate-denied", async () => {
    const result = await runWithGate({
      gate: async () => ({
        kind: "deny",
        reasonCode: "resting",
        reason: "当前处于休息时段：不执行工具。",
        activePauseReasonKinds: ["user-paused", "watchdog"],
      }),
    });
    expect(result.executeCount).toBe(0);
    expect(result.toolErrorCodes).toContain("work-window-gate-denied");
  });

  it("② 拒绝原因里含**全部**暂停原因（不折叠）", async () => {
    const result = await runWithGate({
      gate: async () => ({
        kind: "deny",
        reasonCode: "paused",
        reason: "存在暂停原因。",
        activePauseReasonKinds: ["user-paused", "watchdog"],
      }),
    });
    const finished = result.events.find(
      (event) => event.kind === "toolCallFinished" && (event as { errorCode?: string }).errorCode === "work-window-gate-denied",
    ) as { outputSummary?: string } | undefined;
    expect(JSON.stringify(finished)).toContain("user-paused");
    expect(JSON.stringify(finished)).toContain("watchdog");
  });

  it("③ 门禁放行 ⇒ 工具真的执行", async () => {
    const result = await runWithGate({ gate: async () => ({ kind: "allow", reason: "工作时段" }) });
    expect(result.executeCount).toBe(1);
    expect(result.toolErrorCodes).not.toContain("work-window-gate-denied");
  });

  it("④ 未提供门禁 ⇒ 行为不变（工具照常执行）", async () => {
    const result = await runWithGate({});
    expect(result.executeCount).toBe(1);
  });

  it("⑤ 门禁入参正确：toolName + gatePoint=tool-execution", async () => {
    const result = await runWithGate({ gate: async () => ({ kind: "allow", reason: "工作时段" }) });
    expect(result.gateInputs).toEqual([{ toolName: "write-file", gatePoint: "tool-execution" }]);
  });
});

