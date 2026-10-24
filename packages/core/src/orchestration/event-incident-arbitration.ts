/**
 * EVENT-01（2026-10-24）：**紧急事件仲裁、中断与恢复**的本地可证内核。
 *
 * 验收口径（用户 2026-10-24 确认，见 `docs/reports/EVENT01_ACCEPTANCE_CRITERIA.json`）：
 * - 事件源：`process-exit` / `provider-failure` / `queue-storm` / `tool-crash`；
 * - 响应期限：60 秒（超期**明确降级**，不假装实时）；
 * - 恢复策略：`require-user-confirmation`（未解除不自动继续、不能代替专用授权）；
 * - 完成证据：single-owner / old-epoch-rejected / storm-no-ping-pong /
 *   quota-exhausted-still-receives / recovery-requires-confirmation。
 *
 * 本模块只做**纯状态机**：不读写磁盘、不调模型、不发 IPC。
 */

/** 首期事件源（与验收口径一致；未知来源一律拒绝，不静默接受）。 */
export const EVENT_INCIDENT_KINDS = [
  "process-exit",
  "provider-failure",
  "queue-storm",
  "tool-crash",
] as const;
export type EventIncidentKind = (typeof EVENT_INCIDENT_KINDS)[number];

/** 事故生命周期状态。 */
export const EVENT_INCIDENT_STATES = [
  "received",
  "quiescing",
  "suspended",
  "handling",
  "reconciling",
  "recovered",
  "degraded",
  "rejected",
] as const;
export type EventIncidentState = (typeof EVENT_INCIDENT_STATES)[number];

/** 严重度：同级合并、更高级**抢占**。 */
export const EVENT_SEVERITIES = ["low", "high", "critical"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];
const SEVERITY_RANK: Record<EventSeverity, number> = { low: 0, high: 1, critical: 2 };

/** 恢复策略（与 `event-acceptance-criteria.ts` 的枚举一致）。 */
export type EventRecoveryPolicy =
  | "automatic"
  | "require-user-confirmation"
  | "configurable";

/** 单条事故记录。 */
export interface EventIncident {
  readonly incidentIdentifier: string;
  readonly kind: EventIncidentKind;
  readonly resourceKey: string;
  readonly severity: EventSeverity;
  readonly epoch: number;
  readonly receivedAtIso: string;
  readonly deadlineAtIso: string;
  state: EventIncidentState;
  ownerAgentInstanceId: string | null;
  /** 合并进来的后续事件数（风暴合并，不是丢弃）。 */
  mergedEventCount: number;
  /** 限额已满时**仍然接收**（暂停处理但保留事件，不丢）。 */
  wasReceivedWhileSaturated: boolean;
  degradationReason: string | null;
}

export interface EventIncidentArbitrationOptions {
  /** 同时处理中的事故上限（背压）。 */
  readonly maximumConcurrentIncidents: number;
  /** 响应期限（秒）。 */
  readonly responseDeadlineSeconds: number;
}

export type EventReceiveOutcome =
  | "accepted"
  | "accepted-while-saturated"
  | "merged"
  | "preempted"
  | "rejected-unknown-kind"
  | "rejected-invalid";

export interface EventReceiveResult {
  readonly outcome: EventReceiveOutcome;
  readonly incident: EventIncident | null;
  readonly reason: string;
}

/**
 * 活动状态：**不含 `suspended`**。
 *
 * 被抢占而挂起的事故不再持有资源、也不再是"当前事故"；
 * 否则同一资源上会出现第二个所有者（抢占后再次抢占 = 乒乓），正是卡内禁止的。
 */
const ACTIVE_STATES: ReadonlyArray<EventIncidentState> = [
  "received",
  "quiescing",
  "handling",
  "reconciling",
];

function isActive(incident: EventIncident): boolean {
  return ACTIVE_STATES.includes(incident.state);
}

function rank(severity: EventSeverity): number {
  return SEVERITY_RANK[severity];
}

export class EventIncidentArbitrator {
  private readonly incidents = new Map<string, EventIncident>();
  private readonly maximumConcurrentIncidents: number;
  private readonly responseDeadlineSeconds: number;
  private nextIncidentNumber = 1;

  constructor(options: EventIncidentArbitrationOptions) {
    this.maximumConcurrentIncidents = options.maximumConcurrentIncidents;
    this.responseDeadlineSeconds = options.responseDeadlineSeconds;
  }

  /**
   * 接收一个事件。
   *
   * 规则（对应验收证据）：
   * - 同一资源已有活动事故：
   *   - 更高级别 ⇒ **抢占**（旧事故转 `suspended`，新事故接管），只换一次、不来回；
   *   - 否则 ⇒ **合并**（计数 +1，所有者不变）⇒ 风暴不乒乓；
   * - 并发额度已满 ⇒ **仍然接收**（`wasReceivedWhileSaturated`，状态保持 received 等待处理），
   *   **不丢事件**；
   * - 未知来源 / 非法输入 ⇒ 拒绝并给出原因。
   */
  receive(input: {
    readonly kind: string;
    readonly resourceKey: string;
    readonly severity: string;
    readonly epoch: number;
    readonly receivedAtIso: string;
    readonly incidentIdentifier?: string;
  }): EventReceiveResult {
    if (!(EVENT_INCIDENT_KINDS as ReadonlyArray<string>).includes(input.kind)) {
      return {
        outcome: "rejected-unknown-kind",
        incident: null,
        reason:
          "未知事件源 `" +
          input.kind +
          "`：首期只接受 " +
          EVENT_INCIDENT_KINDS.join(" / ") +
          "（不静默接受来源不明的事件）。",
      };
    }
    if (
      !(EVENT_SEVERITIES as ReadonlyArray<string>).includes(input.severity) ||
      input.resourceKey.trim() === "" ||
      !Number.isSafeInteger(input.epoch) ||
      input.epoch < 0
    ) {
      return {
        outcome: "rejected-invalid",
        incident: null,
        reason: "非法事件参数：严重度/资源键/epoch 不合法。",
      };
    }

    const kind = input.kind as EventIncidentKind;
    const severity = input.severity as EventSeverity;
    const existing = this.findActiveByResource(input.resourceKey);
    if (existing !== null) {
      if (rank(severity) > rank(existing.severity)) {
        existing.state = "suspended";
        existing.degradationReason =
          "被更高级别事故抢占：`" + input.resourceKey + "` 的单一所有者转移给新事故。";
        const preempting = this.createIncident(input, kind, severity);
        this.incidents.set(preempting.incidentIdentifier, preempting);
        return {
          outcome: "preempted",
          incident: preempting,
          reason: "更高级别事故抢占同一资源（旧事故转 suspended，不并行处理）。",
        };
      }
      existing.mergedEventCount += 1;
      return {
        outcome: "merged",
        incident: existing,
        reason:
          "同级/更低级别事故合并进现有事故（合并数 " +
          String(existing.mergedEventCount) +
          "），所有者与状态不变 ⇒ 风暴不乒乓。",
      };
    }

    const activeCount = [...this.incidents.values()].filter(isActive).length;
    const incident = this.createIncident(input, kind, severity);
    incident.wasReceivedWhileSaturated = activeCount >= this.maximumConcurrentIncidents;
    this.incidents.set(incident.incidentIdentifier, incident);
    return incident.wasReceivedWhileSaturated
      ? {
          outcome: "accepted-while-saturated",
          incident,
          reason:
            "并发额度已满：事件**仍然被接收并保留**（暂停处理，不丢弃）。",
        }
      : { outcome: "accepted", incident, reason: "已接收。" };
  }

  /** 声明所有权：同一资源只能有一个所有者（单一所有者）。 */
  claimOwnership(
    incidentIdentifier: string,
    ownerAgentInstanceId: string,
  ): { readonly isOwner: boolean; readonly reason: string } {
    const incident = this.incidents.get(incidentIdentifier);
    if (incident === undefined) {
      return { isOwner: false, reason: "事故不存在。" };
    }
    if (!isActive(incident)) {
      return { isOwner: false, reason: "事故已结束（" + incident.state + "），不能再声明所有权。" };
    }
    if (ownerAgentInstanceId.trim() === "") {
      return { isOwner: false, reason: "所有者标识为空。" };
    }
    if (incident.ownerAgentInstanceId !== null) {
      return {
        isOwner: false,
        reason:
          "单一所有者：资源 `" +
          incident.resourceKey +
          "` 已由 `" +
          incident.ownerAgentInstanceId +
          "` 处理，`" +
          ownerAgentInstanceId +
          "` 不得并行处理。",
      };
    }
    incident.ownerAgentInstanceId = ownerAgentInstanceId;
    incident.state = "handling";
    return { isOwner: true, reason: "已成为该事故的唯一所有者。" };
  }

  /** 用 epoch 提交：旧 epoch 一律拒绝（fencing）。 */
  commitWithEpoch(
    incidentIdentifier: string,
    epoch: number,
  ): { readonly isAccepted: boolean; readonly reason: string } {
    const incident = this.incidents.get(incidentIdentifier);
    if (incident === undefined) {
      return { isAccepted: false, reason: "事故不存在。" };
    }
    if (!Number.isSafeInteger(epoch) || epoch < incident.epoch) {
      return {
        isAccepted: false,
        reason:
          "旧 epoch 拒绝：提交 epoch=" +
          String(epoch) +
          " 低于事故 epoch=" +
          String(incident.epoch) +
          "。",
      };
    }
    return { isAccepted: true, reason: "epoch 有效。" };
  }

  /** 推进状态（只允许向前，防回退）。 */
  advanceState(
    incidentIdentifier: string,
    nextState: EventIncidentState,
  ): { readonly isAdvanced: boolean; readonly reason: string } {
    const incident = this.incidents.get(incidentIdentifier);
    if (incident === undefined) {
      return { isAdvanced: false, reason: "事故不存在。" };
    }
    const currentOrder = EVENT_INCIDENT_STATES.indexOf(incident.state);
    const nextOrder = EVENT_INCIDENT_STATES.indexOf(nextState);
    if (nextOrder <= currentOrder) {
      return {
        isAdvanced: false,
        reason:
          "状态只能前进（当前 " + incident.state + "，请求 " + nextState + "）。",
      };
    }
    incident.state = nextState;
    return { isAdvanced: true, reason: "状态已推进。" };
  }

  /**
   * 响应期限检查：超期**明确降级**（不凭字段承诺实时）。
   *
   * 返回 `isOverdue` 并就地标记 `degraded` + 可读原因。
   */
  evaluateDeadline(
    incidentIdentifier: string,
    nowIso: string,
  ): { readonly isOverdue: boolean; readonly reason: string } {
    const incident = this.incidents.get(incidentIdentifier);
    if (incident === undefined) {
      return { isOverdue: false, reason: "事故不存在。" };
    }
    if (!isActive(incident)) {
      return { isOverdue: false, reason: "事故已结束。" };
    }
    const nowMilliseconds = Date.parse(nowIso);
    const deadlineMilliseconds = Date.parse(incident.deadlineAtIso);
    if (!Number.isFinite(nowMilliseconds) || !Number.isFinite(deadlineMilliseconds)) {
      return { isOverdue: false, reason: "时间不可解析，按未超期处理（不误降级）。" };
    }
    if (nowMilliseconds < deadlineMilliseconds) {
      return { isOverdue: false, reason: "未超期。" };
    }
    incident.state = "degraded";
    incident.degradationReason =
      "超过响应期限（" +
      String(this.responseDeadlineSeconds) +
      " 秒）：明确降级，不假装实时处理。";
    return { isOverdue: true, reason: incident.degradationReason };
  }

  /**
   * 恢复判定：未解除不自动继续；按策略要求用户确认；对账没通过一律不允许。
   */
  evaluateRecovery(
    incidentIdentifier: string,
    input: {
      readonly isReconciled: boolean;
      readonly userConfirmed: boolean;
      readonly recoveryPolicy: EventRecoveryPolicy;
    },
  ): { readonly isAllowed: boolean; readonly reason: string } {
    const incident = this.incidents.get(incidentIdentifier);
    if (incident === undefined) {
      return { isAllowed: false, reason: "事故不存在。" };
    }
    if (!input.isReconciled) {
      return {
        isAllowed: false,
        reason: "未完成对账：**未解除不自动继续**（恢复前必须对账通过）。",
      };
    }
    if (input.recoveryPolicy === "require-user-confirmation" && !input.userConfirmed) {
      return {
        isAllowed: false,
        reason:
          "恢复策略为 require-user-confirmation：必须由用户显式确认，事件本身不构成授权。",
      };
    }
    if (input.recoveryPolicy === "automatic" && !input.userConfirmed) {
      return {
        isAllowed: true,
        reason: "恢复策略为 automatic：对账通过后自动恢复（仍需遵守专用授权）。",
      };
    }
    incident.state = "recovered";
    return {
      isAllowed: true,
      reason:
        input.recoveryPolicy === "require-user-confirmation"
          ? "对账通过且用户已确认：允许恢复。"
          : "对账通过：允许恢复。",
    };
  }

  /**
   * 崩溃重放：用快照恢复事故（保留状态、所有者、epoch、合并计数）。
   *
   * 只用于**同一控制面**的重启恢复；不重置所有者、不假装已恢复执行。
   */
  restoreIncidents(incidents: ReadonlyArray<EventIncident>): void {
    for (const incident of incidents) {
      this.incidents.set(incident.incidentIdentifier, { ...incident });
      const numericSuffix = Number.parseInt(incident.incidentIdentifier.replace(/^incident-/, ""), 10);
      if (Number.isSafeInteger(numericSuffix) && numericSuffix >= this.nextIncidentNumber) {
        this.nextIncidentNumber = numericSuffix + 1;
      }
    }
  }
  /** 只读查询（测试与上层汇报用）。 */
  getIncident(incidentIdentifier: string): EventIncident | null {
    return this.incidents.get(incidentIdentifier) ?? null;
  }

  listIncidents(): ReadonlyArray<EventIncident> {
    return [...this.incidents.values()];
  }

  private findActiveByResource(resourceKey: string): EventIncident | null {
    for (const incident of this.incidents.values()) {
      if (incident.resourceKey === resourceKey && isActive(incident)) return incident;
    }
    return null;
  }

  private createIncident(
    input: {
      readonly resourceKey: string;
      readonly epoch: number;
      readonly receivedAtIso: string;
      readonly incidentIdentifier?: string;
    },
    kind: EventIncidentKind,
    severity: EventSeverity,
  ): EventIncident {
    const receivedMilliseconds = Date.parse(input.receivedAtIso);
    const deadlineAtIso = Number.isFinite(receivedMilliseconds)
      ? new Date(receivedMilliseconds + this.responseDeadlineSeconds * 1000).toISOString()
      : input.receivedAtIso;
    return {
      incidentIdentifier:
        input.incidentIdentifier ??
        "incident-" + String(this.nextIncidentNumber++).padStart(4, "0"),
      kind,
      resourceKey: input.resourceKey,
      severity,
      epoch: input.epoch,
      receivedAtIso: input.receivedAtIso,
      deadlineAtIso,
      state: "received",
      ownerAgentInstanceId: null,
      mergedEventCount: 0,
      wasReceivedWhileSaturated: false,
      degradationReason: null,
    };
  }
}


