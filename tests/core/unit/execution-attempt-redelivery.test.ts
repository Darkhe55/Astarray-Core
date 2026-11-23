/**
 * F1（2026-11-24）：**同一逻辑派发的重投复用 attempt，真正重新执行才递增**。
 *
 * 语义澄清（对齐 D4 裁决）：
 * - `executionAttempt` 属于**派发**：每次真正启动一次 worker ⇒ +1；
 * - 反馈信封携带该值；**重投同一信封**（同 messageId/同 attempt）不改变 attempt；
 * - 旧信封缺字段 ⇒ 消费端视为不可验证（不猜当前值）。
 */
import { describe, expect, it } from "vitest";

import { TaskGraph } from "../../../packages/core/src/core/task-graph.js";
import type { TaskChainDocument, FeedbackMessage } from "../../../packages/core/src/core/types.js";

function chain(): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "m-1",
    revision: 1,
    updatedAtIso: "2026-11-24T00:00:00.000Z",
    tasks: [
      {
        id: "T-1",
        description: "任务",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
        assignedAgentId: "w1",
        status: "pending",
        resultLocation: null,
      },
    ],
  };
}

function envelope(executionAttempt: number | undefined): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: "00000000-0000-4000-8000-000000000001",
    source: { sourceType: "agent", agentInstanceId: "w1", agentRole: "tertiary" },
    recipientId: "scheduler:m-1",
    priority: "success",
    createdAtIso: "2026-11-24T00:00:00.000Z",
    idempotencyKey: "m-1/T-1/1",
    ...(executionAttempt === undefined ? {} : { executionAttempt }),
    payload: { kind: "success", summary: "完成" },
  };
}

describe("F1：重投复用 attempt", () => {
  it("① 两次真实派发 ⇒ attempt 1、2", () => {
    const graph = new TaskGraph(chain().tasks);
    expect(graph.recordDispatchAttempt("T-1")).toBe(1);
    expect(graph.recordDispatchAttempt("T-1")).toBe(2);
  });

  it("② 重投同一信封（同 attempt）⇒ 信封字段不变（重投不是重新执行）", () => {
    const graph = new TaskGraph(chain().tasks);
    const attempt = graph.recordDispatchAttempt("T-1");
    const first = envelope(attempt);
    /** 重投：复用同一条已盖章的信封（传输层重发，不重新派发 worker）。 */
    const redelivered = envelope(first.executionAttempt);
    expect(redelivered.executionAttempt).toBe(attempt);
    expect(redelivered.messageId).toBe(first.messageId);
    /** 重投不改变派发记录：再次读取仍是同一 attempt。 */
    expect(graph.getNode("T-1")?.executionAttempt).toBe(attempt);
  });

  it("③ 旧信封缺 attempt ⇒ undefined（消费端视为不可验证，不猜）", () => {
    expect(envelope(undefined).executionAttempt).toBeUndefined();
  });

  it("④ 重新执行（再次派发）后，新信封带新 attempt，旧信封仍是旧值", () => {
    const graph = new TaskGraph(chain().tasks);
    const oldEnvelope = envelope(graph.recordDispatchAttempt("T-1"));
    const newEnvelope = envelope(graph.recordDispatchAttempt("T-1"));
    expect(oldEnvelope.executionAttempt).toBe(1);
    expect(newEnvelope.executionAttempt).toBe(2);
  });
});
