/**
 * EVENT-01 仲裁内核反例（2026-10-24），逐条对应验收口径的 requiredEvidence。
 */
import { describe, expect, it } from "vitest";

import {
  EVENT_INCIDENT_KINDS,
  EventIncidentArbitrator,
} from "../../../packages/core/src/orchestration/event-incident-arbitration.js";

function createArbitrator(maximumConcurrentIncidents = 2) {
  return new EventIncidentArbitrator({
    maximumConcurrentIncidents,
    responseDeadlineSeconds: 60,
  });
}

const receivedAt = "2026-10-24T00:00:00.000Z";

describe("EVENT-01 紧急仲裁内核", () => {
  it("① single-owner：同一资源第二个所有者被拒", () => {
    const arbitrator = createArbitrator();
    const result = arbitrator.receive({
      kind: "tool-crash",
      resourceKey: "agent-1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    });
    expect(result.outcome).toBe("accepted");
    const incident = result.incident!;
    expect(arbitrator.claimOwnership(incident.incidentIdentifier, "agent-1").isOwner).toBe(true);
    const second = arbitrator.claimOwnership(incident.incidentIdentifier, "agent-2");
    expect(second.isOwner).toBe(false);
    expect(second.reason).toContain("单一所有者");
  });

  it("② old-epoch-rejected：旧 epoch 提交被拒", () => {
    const arbitrator = createArbitrator();
    const incident = arbitrator.receive({
      kind: "provider-failure",
      resourceKey: "provider-x",
      severity: "high",
      epoch: 3,
      receivedAtIso: receivedAt,
    }).incident!;
    expect(arbitrator.commitWithEpoch(incident.incidentIdentifier, 2).isAccepted).toBe(false);
    expect(arbitrator.commitWithEpoch(incident.incidentIdentifier, 3).isAccepted).toBe(true);
  });

  it("③ storm-no-ping-pong：同级重复事件合并、所有权不变", () => {
    const arbitrator = createArbitrator();
    const first = arbitrator.receive({
      kind: "queue-storm",
      resourceKey: "queue-1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    });
    const owner = arbitrator.claimOwnership(first.incident!.incidentIdentifier, "agent-1");
    expect(owner.isOwner).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      const merged = arbitrator.receive({
        kind: "queue-storm",
        resourceKey: "queue-1",
        severity: "high",
        epoch: 1,
        receivedAtIso: receivedAt,
      });
      expect(merged.outcome).toBe("merged");
    }
    const incident = arbitrator.getIncident(first.incident!.incidentIdentifier)!;
    expect(incident.mergedEventCount).toBe(20);
    expect(incident.ownerAgentInstanceId).toBe("agent-1");
    expect(arbitrator.listIncidents()).toHaveLength(1);
  });

  it("④ 更高级别才抢占（一次），旧事故转 suspended", () => {
    const arbitrator = createArbitrator();
    const low = arbitrator.receive({
      kind: "queue-storm",
      resourceKey: "queue-1",
      severity: "low",
      epoch: 1,
      receivedAtIso: receivedAt,
    }).incident!;
    const critical = arbitrator.receive({
      kind: "process-exit",
      resourceKey: "queue-1",
      severity: "critical",
      epoch: 2,
      receivedAtIso: receivedAt,
    });
    expect(critical.outcome).toBe("preempted");
    expect(arbitrator.getIncident(low.incidentIdentifier)!.state).toBe("suspended");

    const again = arbitrator.receive({
      kind: "process-exit",
      resourceKey: "queue-1",
      severity: "critical",
      epoch: 2,
      receivedAtIso: receivedAt,
    });
    expect(again.outcome).toBe("merged");
    expect(arbitrator.listIncidents()).toHaveLength(2);
  });

  it("⑤ quota-exhausted-still-receives：额度满仍接收并保留事件", () => {
    const arbitrator = createArbitrator(1);
    const first = arbitrator.receive({
      kind: "process-exit",
      resourceKey: "r1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    });
    expect(first.outcome).toBe("accepted");

    const second = arbitrator.receive({
      kind: "tool-crash",
      resourceKey: "r2",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    });
    expect(second.outcome).toBe("accepted-while-saturated");
    expect(second.incident?.wasReceivedWhileSaturated).toBe(true);
    expect(arbitrator.listIncidents()).toHaveLength(2);
  });

  it("⑥ 响应期限超期 ⇒ 明确降级（不假装实时）", () => {
    const arbitrator = createArbitrator();
    const incident = arbitrator.receive({
      kind: "provider-failure",
      resourceKey: "p1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    }).incident!;
    expect(arbitrator.evaluateDeadline(incident.incidentIdentifier, "2026-10-24T00:00:59.000Z").isOverdue).toBe(false);
    const overdue = arbitrator.evaluateDeadline(incident.incidentIdentifier, "2026-10-24T00:01:01.000Z");
    expect(overdue.isOverdue).toBe(true);
    expect(incident.state).toBe("degraded");
    expect(overdue.reason).toContain("降级");
  });

  it("⑦ recovery-requires-confirmation：未对账/未确认都不恢复", () => {
    const arbitrator = createArbitrator();
    const incident = arbitrator.receive({
      kind: "process-exit",
      resourceKey: "r1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    }).incident!;
    const notReconciled = arbitrator.evaluateRecovery(incident.incidentIdentifier, {
      isReconciled: false,
      userConfirmed: true,
      recoveryPolicy: "require-user-confirmation",
    });
    expect(notReconciled.isAllowed).toBe(false);
    expect(notReconciled.reason).toContain("未解除");

    const notConfirmed = arbitrator.evaluateRecovery(incident.incidentIdentifier, {
      isReconciled: true,
      userConfirmed: false,
      recoveryPolicy: "require-user-confirmation",
    });
    expect(notConfirmed.isAllowed).toBe(false);
    expect(notConfirmed.reason).toContain("用户显式确认");

    const allowed = arbitrator.evaluateRecovery(incident.incidentIdentifier, {
      isReconciled: true,
      userConfirmed: true,
      recoveryPolicy: "require-user-confirmation",
    });
    expect(allowed.isAllowed).toBe(true);
    expect(incident.state).toBe("recovered");
  });

  it("⑧ automatic 策略：对账通过即可恢复，但仍不替代专用授权", () => {
    const arbitrator = createArbitrator();
    const incident = arbitrator.receive({
      kind: "tool-crash",
      resourceKey: "r1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    }).incident!;
    const allowed = arbitrator.evaluateRecovery(incident.incidentIdentifier, {
      isReconciled: true,
      userConfirmed: false,
      recoveryPolicy: "automatic",
    });
    expect(allowed.isAllowed).toBe(true);
    expect(allowed.reason).toContain("专用授权");
  });

  it("⑨ 未知事件源被拒（不静默接受）", () => {
    const arbitrator = createArbitrator();
    const result = arbitrator.receive({
      kind: "cosmic-ray",
      resourceKey: "r1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    });
    expect(result.outcome).toBe("rejected-unknown-kind");
    expect(EVENT_INCIDENT_KINDS).toHaveLength(4);
    expect(arbitrator.listIncidents()).toHaveLength(0);
  });

  it("⑩ 状态只能前进（不能把已降级事故改回 handling）", () => {
    const arbitrator = createArbitrator();
    const incident = arbitrator.receive({
      kind: "process-exit",
      resourceKey: "r1",
      severity: "high",
      epoch: 1,
      receivedAtIso: receivedAt,
    }).incident!;
    arbitrator.advanceState(incident.incidentIdentifier, "quiescing");
    const back = arbitrator.advanceState(incident.incidentIdentifier, "received");
    expect(back.isAdvanced).toBe(false);
    expect(back.reason).toContain("只能前进");
  });
});
