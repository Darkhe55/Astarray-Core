/**
 * EVENT-01 控制通道反例（2026-10-24）：门禁 / 工具取消 / 分阶段确认 / 崩溃重放。
 */
import { describe, expect, it } from "vitest";

import {
  EventControlChannel,
} from "../../../packages/core/src/orchestration/event-control-channel.js";

function createChannel() {
  return new EventControlChannel({
    maximumConcurrentIncidents: 2,
    responseDeadlineSeconds: 60,
    recoveryPolicy: "require-user-confirmation",
  });
}

const at = "2026-10-24T00:00:00.000Z";

describe("EVENT-01 控制通道", () => {
  it("① 无事故 ⇒ 模型与工具调用都允许", () => {
    const channel = createChannel();
    channel.registerToolCapabilities([{ toolName: "readFile", supportsCancellation: true }]);
    expect(channel.beforeModelCall(at).isAllowed).toBe(true);
    expect(channel.beforeToolCall("readFile", at).isAllowed).toBe(true);
  });

  it("② 收到事件 ≠ 已停止：模型调用立即被门禁拒绝", () => {
    const channel = createChannel();
    const result = channel.receiveEvent({
      kind: "process-exit",
      resourceKey: "runtime-1",
      severity: "critical",
      epoch: 1,
      receivedAtIso: at,
    });
    expect(result.outcome).toBe("accepted");
    const decision = channel.beforeModelCall(at);
    expect(decision.isAllowed).toBe(false);
    if (!decision.isAllowed) expect(decision.blockingIncidentIdentifiers).toHaveLength(1);
  });

  it("③ 未登记取消能力的工具 ⇒ 事故期间不得启动（不统一 kill）", () => {
    const channel = createChannel();
    channel.receiveEvent({ kind: "tool-crash", resourceKey: "r1", severity: "high", epoch: 1, receivedAtIso: at });
    const decision = channel.beforeToolCall("unknownTool", at);
    expect(decision.isAllowed).toBe(false);
  });

  it("④ 取消结果按能力如实回报；一律仍需在途确认", () => {
    const channel = createChannel();
    channel.registerToolCapabilities([
      { toolName: "cancellable", supportsCancellation: true },
      { toolName: "blocking", supportsCancellation: false },
    ]);
    const cancellable = channel.requestToolCancellation("cancellable");
    expect(cancellable.outcome).toBe("cancel-requested");
    expect(cancellable.requiresInFlightConfirmation).toBe(true);
    expect(cancellable.reason).toContain("≠ 已停止");

    const blocking = channel.requestToolCancellation("blocking");
    expect(blocking.outcome).toBe("not-supported");
    expect(blocking.requiresInFlightConfirmation).toBe(true);

    const unknown = channel.requestToolCancellation("mystery");
    expect(unknown.outcome).toBe("unknown-tool");
  });

  it("⑤ 在途副作用必须用户确认 + 对账通过", () => {
    const channel = createChannel();
    const incident = channel.receiveEvent({
      kind: "process-exit",
      resourceKey: "r1",
      severity: "high",
      epoch: 1,
      receivedAtIso: at,
    }).incident!;

    expect(
      channel.confirmInFlightSideEffect({
        incidentIdentifier: incident.incidentIdentifier,
        userConfirmed: false,
        isReconciled: true,
      }).isAccepted,
    ).toBe(false);
    expect(
      channel.confirmInFlightSideEffect({
        incidentIdentifier: incident.incidentIdentifier,
        userConfirmed: true,
        isReconciled: false,
      }).isAccepted,
    ).toBe(false);
    expect(
      channel.confirmInFlightSideEffect({
        incidentIdentifier: incident.incidentIdentifier,
        userConfirmed: true,
        isReconciled: true,
      }).isAccepted,
    ).toBe(true);
  });

  it("⑥ 崩溃重放：状态、所有者与门禁都保留（不假装已恢复执行）", () => {
    const channel = createChannel();
    const incident = channel.receiveEvent({
      kind: "process-exit",
      resourceKey: "r1",
      severity: "critical",
      epoch: 3,
      receivedAtIso: at,
    }).incident!;
    const snapshot = channel.toSnapshot();

    const replayed = EventControlChannel.fromSnapshot({
      snapshot,
      maximumConcurrentIncidents: 2,
      responseDeadlineSeconds: 60,
    });
    const decision = replayed.beforeModelCall(at);
    expect(decision.isAllowed).toBe(false);
    const restored = replayed.toSnapshot().incidents[0]!;
    expect(restored.incidentIdentifier).toBe(incident.incidentIdentifier);
    expect(restored.epoch).toBe(3);
    expect(restored.severity).toBe("critical");
  });

  it("⑦ 恢复仍需用户确认（require-user-confirmation）", () => {
    const channel = createChannel();
    const incident = channel.receiveEvent({
      kind: "tool-crash",
      resourceKey: "r1",
      severity: "high",
      epoch: 1,
      receivedAtIso: at,
    }).incident!;
    expect(
      channel.evaluateRecovery(incident.incidentIdentifier, { isReconciled: true, userConfirmed: false })
        .isAllowed,
    ).toBe(false);
    expect(
      channel.evaluateRecovery(incident.incidentIdentifier, { isReconciled: true, userConfirmed: true })
        .isAllowed,
    ).toBe(true);
  });

  it("⑧ 响应期限超期 ⇒ 事故转 degraded，不再阻塞模型调用（明确降级）", () => {
    const channel = createChannel();
    channel.receiveEvent({
      kind: "queue-storm",
      resourceKey: "q1",
      severity: "high",
      epoch: 1,
      receivedAtIso: at,
    });
    const laterAt = "2026-10-24T00:01:30.000Z";
    const decision = channel.beforeModelCall(laterAt);
    expect(decision.isAllowed).toBe(true);
  });
});

