/**
 * EVENT-01（2026-10-24）：**控制通道、工具取消与分阶段确认、崩溃重放**。
 *
 * 卡内验收（EVENT-01-02 / 01-04）：
 * - "绕过 idle/pn 的控制通道、executionEpoch 门禁、工具能力取消及分阶段确认"；
 * - "收到事件不等于已停止；旧 epoch 调用/适用提交拒绝；在途副作用须确认；不统一 kill、不绕过授权/备份"；
 * - "未解除不自动继续；不能代替专用授权；无重复副作用；反馈故障明确降级"。
 *
 * 本模块把仲裁内核（`EventIncidentArbitrator`）接成**可判定的控制面**：
 * - `beforeModelCall` / `beforeToolCall`：在模型与工具前**门禁**（不持锁、不猜）；
 * - `requestToolCancellation`：按**适配器能力**取消；不支持 ⇒ 如实回报，不假装已停止；
 * - `confirmInFlightSideEffect`：在途副作用必须分阶段确认（不能代替专用授权）；
 * - `toSnapshot` / `fromSnapshot`：崩溃后重放（状态与所有者不丢）。
 */
import {
  EventIncidentArbitrator,
  type EventIncident,
  type EventIncidentKind,
  type EventRecoveryPolicy,
  type EventSeverity,
} from "./event-incident-arbitration.js";

/** 工具取消能力（由适配器声明；未声明 = 不支持，不猜）。 */
export interface EventToolCancellationCapability {
  readonly toolName: string;
  readonly supportsCancellation: boolean;
}

export type EventGateDecision =
  | { readonly isAllowed: true; readonly reason: string }
  | {
      readonly isAllowed: false;
      readonly reason: string;
      /** 阻止继续的未解除事故（为空表示非事故原因）。 */
      readonly blockingIncidentIdentifiers: ReadonlyArray<string>;
    };

export interface EventControlChannelSnapshot {
  readonly schemaVersion: 1;
  readonly incidents: ReadonlyArray<EventIncident>;
  readonly toolCapabilities: ReadonlyArray<EventToolCancellationCapability>;
}

const BLOCKING_STATES: ReadonlyArray<EventIncident["state"]> = [
  "received",
  "quiescing",
  "handling",
  "reconciling",
];

export class EventControlChannel {
  private readonly arbitrator: EventIncidentArbitrator;
  private readonly capabilitiesByToolName = new Map<string, boolean>();

  constructor(options: {
    readonly maximumConcurrentIncidents: number;
    readonly responseDeadlineSeconds: number;
    readonly recoveryPolicy?: EventRecoveryPolicy;
  }) {
    this.arbitrator = new EventIncidentArbitrator({
      maximumConcurrentIncidents: options.maximumConcurrentIncidents,
      responseDeadlineSeconds: options.responseDeadlineSeconds,
    });
    this.recoveryPolicy = options.recoveryPolicy ?? "require-user-confirmation";
  }

  private readonly recoveryPolicy: EventRecoveryPolicy;

  /** 登记适配器的取消能力（覆盖式；未登记的工具有一律视为不支持）。 */
  registerToolCapabilities(capabilities: ReadonlyArray<EventToolCancellationCapability>): void {
    for (const capability of capabilities) {
      this.capabilitiesByToolName.set(capability.toolName, capability.supportsCancellation);
    }
  }

  /** 接收一个紧急事件（转给仲裁内核，行为与内核一致）。 */
  receiveEvent(input: {
    readonly kind: string;
    readonly resourceKey: string;
    readonly severity: string;
    readonly epoch: number;
    readonly receivedAtIso: string;
    readonly incidentIdentifier?: string;
  }) {
    return this.arbitrator.receive(input);
  }

  /**
   * 模型调用前门禁：有未解除事故 ⇒ 拒绝新模型调用。
   *
   * 注意：这是**控制通道**，不依赖 idle/PN 状态；事件到达即生效。
   */
  beforeModelCall(nowIso: string): EventGateDecision {
    this.markOverdueIncidents(nowIso);
    const blocking = this.arbitrator
      .listIncidents()
      .filter(
        (incident) =>
          BLOCKING_STATES.includes(incident.state) &&
          // 低严重度事故只记录/合并，不阻断执行（避免普通工具错误把整轮停死）。
          (incident.severity === "high" || incident.severity === "critical"),
      );
    if (blocking.length === 0) {
      return { isAllowed: true, reason: "没有未解除事故，允许模型调用。" };
    }
    return {
      isAllowed: false,
      reason:
        "存在未解除事故（" +
        blocking.map((incident) => incident.incidentIdentifier).join(",") +
        "）：控制通道要求先隔离/取消，再继续。",
      blockingIncidentIdentifiers: blocking.map((incident) => incident.incidentIdentifier),
    };
  }

  /**
   * 工具调用前门禁：与模型调用同源，但**额外**要求该工具已声明可取消能力，
   * 否则不得在事故中启动新的副作用（不统一 kill、不绕过授权）。
   */
  beforeToolCall(toolName: string, nowIso: string): EventGateDecision {
    const baseDecision = this.beforeModelCall(nowIso);
    if (!baseDecision.isAllowed) return baseDecision;
    if (this.capabilitiesByToolName.get(toolName) === false) {
      return {
        isAllowed: false,
        reason:
          "工具 `" + toolName + "` 未声明可取消能力：事故期间不得启动可能无法停止的副作用。",
        blockingIncidentIdentifiers: [],
      };
    }
    return { isAllowed: true, reason: "允许工具调用。" };
  }

  /**
   * 请求取消工具。
   *
   * - 未登记能力 ⇒ `unknown-tool`（不假装已停止）；
   * - 登记为不支持 ⇒ `not-supported`（需要用户/控制面接管）；
   * - 支持 ⇒ `cancel-requested`，且**仍需确认**（收到事件 ≠ 已停止）。
   */
  requestToolCancellation(toolName: string): {
    readonly outcome: "cancel-requested" | "not-supported" | "unknown-tool";
    readonly requiresInFlightConfirmation: boolean;
    readonly reason: string;
  } {
    const supports = this.capabilitiesByToolName.get(toolName);
    if (supports === undefined) {
      return {
        outcome: "unknown-tool",
        requiresInFlightConfirmation: true,
        reason: "工具 `" + toolName + "` 未登记取消能力：按未知处理，不能声称已停止。",
      };
    }
    if (!supports) {
      return {
        outcome: "not-supported",
        requiresInFlightConfirmation: true,
        reason:
          "工具 `" + toolName + "` 不支持取消：需等待其自然结束并确认在途副作用（不统一 kill）。",
      };
    }
    return {
      outcome: "cancel-requested",
      requiresInFlightConfirmation: true,
      reason: "已发出取消请求；**取消请求 ≠ 已停止**，须确认在途副作用。",
    };
  }

  /**
   * 分阶段确认在途副作用：必须显式用户确认 + 对账通过；不得代替专用授权。
   */
  confirmInFlightSideEffect(input: {
    readonly incidentIdentifier: string;
    readonly userConfirmed: boolean;
    readonly isReconciled: boolean;
  }): { readonly isAccepted: boolean; readonly reason: string } {
    if (!input.userConfirmed) {
      return {
        isAccepted: false,
        reason: "在途副作用必须由用户显式确认（不默认继续、不代替专用授权）。",
      };
    }
    if (!input.isReconciled) {
      return { isAccepted: false, reason: "未完成对账：不得宣称副作用已收敛。" };
    }
    const incident = this.arbitrator.getIncident(input.incidentIdentifier);
    if (incident === null) {
      return { isAccepted: false, reason: "事故不存在。" };
    }
    return { isAccepted: true, reason: "已确认在途副作用并完成对账。" };
  }

  /** 恢复判定（转给仲裁内核；未解除不自动继续）。 */
  evaluateRecovery(
    incidentIdentifier: string,
    input: { readonly isReconciled: boolean; readonly userConfirmed: boolean },
  ) {
    return this.arbitrator.evaluateRecovery(incidentIdentifier, {
      isReconciled: input.isReconciled,
      userConfirmed: input.userConfirmed,
      recoveryPolicy: this.recoveryPolicy,
    });
  }

  /** 崩溃前快照（含所有者与状态）。 */
  toSnapshot(): EventControlChannelSnapshot {
    return {
      schemaVersion: 1,
      incidents: this.arbitrator.listIncidents().map((incident) => ({ ...incident })),
      toolCapabilities: [...this.capabilitiesByToolName.entries()].map(
        ([toolName, supportsCancellation]) => ({ toolName, supportsCancellation }),
      ),
    };
  }

  /** 从快照恢复（崩溃重放；不重置所有者、不假装恢复执行）。 */
  static fromSnapshot(input: {
    readonly snapshot: EventControlChannelSnapshot;
    readonly maximumConcurrentIncidents: number;
    readonly responseDeadlineSeconds: number;
    readonly recoveryPolicy?: EventRecoveryPolicy;
  }): EventControlChannel {
    const channel = new EventControlChannel({
      maximumConcurrentIncidents: input.maximumConcurrentIncidents,
      responseDeadlineSeconds: input.responseDeadlineSeconds,
      ...(input.recoveryPolicy === undefined ? {} : { recoveryPolicy: input.recoveryPolicy }),
    });
    channel.registerToolCapabilities(input.snapshot.toolCapabilities);
    channel.arbitrator.restoreIncidents(input.snapshot.incidents);
    return channel;
  }

  private markOverdueIncidents(nowIso: string): void {
    for (const incident of this.arbitrator.listIncidents()) {
      if (BLOCKING_STATES.includes(incident.state)) {
        this.arbitrator.evaluateDeadline(incident.incidentIdentifier, nowIso);
      }
    }
  }
}

/** 重新导出常用类型，方便调用方只依赖控制通道。 */
export type { EventIncident, EventIncidentKind, EventRecoveryPolicy, EventSeverity };

