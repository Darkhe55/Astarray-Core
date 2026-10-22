/**
 * GUIDE-01-02 反例（2026-10-22）：**busy 期间即可在安全点应用**、**同指导幂等**、
 * **普通报告不唤醒主 Agent**、跨作用域/过期在消费点丢弃、更高 revision 取代旧条。
 */
import { describe, expect, it } from "vitest";

import {
  GuidanceControlQueue,
  evaluateWakePolicy,
} from "../../../packages/core/src/runtime-guidance/guidance-control-queue.js";
import {
  GuidanceSourceRegistry,
  buildRuntimeGuidanceEvent,
} from "../../../packages/core/src/runtime-guidance/runtime-guidance.js";

const nowIso = "2026-10-22T10:00:00.000Z";
const target = { missionIdentifier: "mission-1", taskIdentifier: "task-1", resourceIdentifier: null };

function buildQueue() {
  const registry = new GuidanceSourceRegistry();
  registry.register({
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    maximumBehaviorTier: "gate-and-request-pause",
    registeredAtIso: nowIso,
  });
  const statusEvents: string[] = [];
  const queue = new GuidanceControlQueue({
    sourceRegistry: registry,
    nowIso: () => nowIso,
    onStatusChanged: (entry) => statusEvents.push(`${entry.guidanceIdentifier}:${entry.status}`),
  });
  return { queue, statusEvents };
}

function guidance(overrides: Record<string, unknown> = {}) {
  return buildRuntimeGuidanceEvent({
    guidanceIdentifier: "guidance-1",
    guidanceRevision: 1,
    sequence: 1,
    sourceKind: "authenticated-user",
    sourceIdentifier: "user-1",
    issuedAtIso: nowIso,
    expiresAtIso: null,
    behaviorTier: "safe-point-guidance",
    scope: { scopeKind: "task", missionIdentifier: "mission-1", taskIdentifier: "task-1", resourceIdentifier: null },
    instructionText: "先跑只读检查",
    ...overrides,
  });
}

describe("GUIDE-01-02 安全点应用", () => {
  it("① busy 期间的指导：入队返回 accepted，但**尚未应用**（不等整链结束）", () => {
    const { queue } = buildQueue();
    const result = queue.enqueueControlGuidance({ event: guidance(), target, nowIso });
    expect(result.status).toBe("accepted");
    expect(queue.listAppliedGuidance()).toHaveLength(0);
    expect(queue.listPendingGuidance()).toHaveLength(1);
  });

  it("② 在**链中**安全点（before-model-call）即可应用，不必等任务结束", () => {
    const { queue } = buildQueue();
    queue.enqueueControlGuidance({ event: guidance(), target, nowIso });
    const consumption = queue.consumeAtSafePoint({ safePointKind: "before-model-call", target, nowIso });
    expect(consumption.applied).toHaveLength(1);
    expect(queue.listPendingGuidance()).toHaveLength(0);
    expect(queue.listAppliedGuidance()).toHaveLength(1);
  });

  it("③ 同一指导**幂等**：第二次安全点不会重复应用", () => {
    const { queue } = buildQueue();
    queue.enqueueControlGuidance({ event: guidance(), target, nowIso });
    queue.consumeAtSafePoint({ safePointKind: "before-model-call", target, nowIso });
    const second = queue.consumeAtSafePoint({ safePointKind: "before-tool-execution", target, nowIso });
    expect(second.applied).toHaveLength(0);
    expect(queue.listAppliedGuidance()).toHaveLength(1);
  });

  it("④ 普通报告**不唤醒**主 Agent；控制通道可唤醒（策略分离）", () => {
    const { queue } = buildQueue();
    const report = queue.enqueueOrdinaryReport({
      reportIdentifier: "report-1",
      recipientId: "main-agent-1",
      sourceIdentifier: "worker-1",
      summary: "进度报告",
    });
    expect(report.shouldWakeMainAgent).toBe(false);
    const policy = queue.readWakePolicy();
    // 真实契约：两条通道都**不唤醒**主 Agent（控制通道改为"在安全点应用"）
    expect(policy.control.wakesMainAgent).toBe(false);
    expect(policy.report.wakesMainAgent).toBe(false);
    expect(policy.control.isAppliedToRunningMissionAtSafePoint).toBe(true);
    expect(policy.report.isQueuedOnly).toBe(true);
    expect(evaluateWakePolicy("report").wakesMainAgent).toBe(false);
  });

  it("⑤ 跨作用域：到安全点才丢弃并给原因（不套用到别的任务）", () => {
    const { queue } = buildQueue();
    queue.enqueueControlGuidance({ event: guidance(), target, nowIso });
    const consumption = queue.consumeAtSafePoint({
      safePointKind: "before-model-call",
      target: { missionIdentifier: "mission-2", taskIdentifier: "task-1", resourceIdentifier: null },
      nowIso,
    });
    expect(consumption.applied).toHaveLength(0);
    expect(consumption.dropped[0]?.reason).toContain("cross-scope");
  });

  it("⑥ 更高 revision 取代旧条：旧条被标 superseded 且不会被应用", () => {
    const { queue } = buildQueue();
    queue.enqueueControlGuidance({ event: guidance({ guidanceIdentifier: "g", guidanceRevision: 1, sequence: 1 }), target, nowIso });
    queue.enqueueControlGuidance({ event: guidance({ guidanceIdentifier: "g", guidanceRevision: 2, sequence: 2 }), target, nowIso });
    const status = queue.listGuidanceStatus();
    expect(status.filter((entry) => entry.status === "superseded")).toHaveLength(1);
    const consumption = queue.consumeAtSafePoint({ safePointKind: "before-model-call", target, nowIso });
    expect(consumption.applied.map((entry) => entry.guidanceRevision)).toEqual([2]);
  });
});

