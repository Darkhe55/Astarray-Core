/**
 * EVENT-01（2026-10-24）：**生产事件源桥**。
 *
 * 把 `event-source-policy` 的判定接到 `EventControlChannel`（仲裁/门禁）与
 * `EventIncidentJournal`（持久化）上，供 worker / provider 失败路径调用：
 * - `onToolFailed`：崩溃类错误 ⇒ `tool-crash` critical（普通错误不产生事故）；
 * - `onProviderFailure`：连续 3 次 ⇒ `provider-failure` high；成功即清零；
 * - 同键 60 秒去重（窗口内不重复发事件，避免风暴）；
 * - `gate`：模型/工具调用前门禁（直接可作 `workWindowGate` 使用）；
 * - 观测/落盘失败**不得阻塞业务**（与 perf/diag 同一纪律）。
 */
import type { EventIncidentKind, EventSeverity, EventRecoveryPolicy } from "./event-incident-arbitration.js";
import type { EventControlChannel } from "./event-control-channel.js";
import type { EventIncidentJournal } from "./event-incident-journal.js";
import {
  evaluateToolFailureSignal,
  EventSourceDeduplicator,
  ProviderFailureCounter,
  type EventSourceSignal,
} from "./event-source-policy.js";

export type EventSourceGateDecision =
  | { readonly kind: "allow"; readonly reason: string }
  | { readonly kind: "deny"; readonly reasonCode: string; readonly reason: string };

export interface EventSourceBridgeOptions {
  readonly channel: EventControlChannel;
  readonly journal?: EventIncidentJournal;
  readonly recoveryPolicy?: EventRecoveryPolicy;
}

export class EventSourceBridge {
  private readonly channel: EventControlChannel;
  private readonly journal: EventIncidentJournal | undefined;
  private readonly deduplicator = new EventSourceDeduplicator();
  private readonly providerFailures = new ProviderFailureCounter();
  private pendingJournalWrite: Promise<void> = Promise.resolve();
  private journalRevision = 0;
  private hasLoadedJournalRevision = false;

  constructor(options: EventSourceBridgeOptions) {
    this.channel = options.channel;
    this.journal = options.journal;
  }

  /** 工具失败：只有崩溃类错误才产生事故。 */
  async onToolFailed(input: {
    readonly toolName: string;
    readonly failureReason: string;
    readonly nowMilliseconds?: number;
    readonly receivedAtIso?: string;
  }): Promise<{ readonly signal: EventSourceSignal | null; readonly isNewIncident: boolean; readonly wasEmitted: boolean }> {
    const signal = evaluateToolFailureSignal(input);
    if (signal === null) return { signal: null, isNewIncident: false, wasEmitted: false };
    return this.emit(signal, input.nowMilliseconds ?? Date.now(), input.receivedAtIso);
  }

  /** provider 失败：连续 3 次才产生事故；成功清零。 */
  async onProviderFailure(input: {
    readonly resourceKey: string;
    readonly nowMilliseconds?: number;
    readonly receivedAtIso?: string;
  }): Promise<{
    readonly signal: EventSourceSignal | null;
    readonly isNewIncident: boolean;
    readonly consecutiveFailureCount: number;
  }> {
    const counter = this.providerFailures.onFailure(input.resourceKey);
    if (counter.shouldSignal !== true) {
      return {
        signal: null,
        isNewIncident: false,
        consecutiveFailureCount: counter.consecutiveFailureCount,
      };
    }
    const signal: EventSourceSignal = {
      kind: "provider-failure",
      severity: "high",
      resourceKey: "provider:" + input.resourceKey,
      reason:
        "provider `" +
        input.resourceKey +
        "` 连续失败 " +
        String(counter.consecutiveFailureCount) +
        " 次（阈值 " +
        String(3) +
        "）",
    };
    const emitted = await this.emit(signal, input.nowMilliseconds ?? Date.now(), input.receivedAtIso);
    return {
      ...emitted,
      consecutiveFailureCount: counter.consecutiveFailureCount,
    };
  }

  onProviderSuccess(resourceKey: string): void {
    this.providerFailures.onSuccess(resourceKey);
  }

  /**
   * 模型/工具前门禁（可直接交给 `workWindowGate`）。
   *
   * 只在有 `high`/`critical` 未解除事故时拒绝；低严重度只记录。
   */
  async gate(input: {
    readonly toolName?: string;
    readonly gatePoint: "model" | "tool-execution";
    readonly nowIso?: string;
  }): Promise<EventSourceGateDecision> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const decision =
      input.gatePoint === "model"
        ? this.channel.beforeModelCall(nowIso)
        : this.channel.beforeToolCall(input.toolName ?? "", nowIso);
    if (decision.isAllowed) return { kind: "allow", reason: decision.reason };
    return { kind: "deny", reasonCode: "event-incident-active", reason: decision.reason };
  }

  /** 等待在途日志写入（测试与优雅关闭用）。 */
  async flush(): Promise<void> {
    await this.pendingJournalWrite;
  }

  private async emit(
    signal: EventSourceSignal,
    nowMilliseconds: number,
    receivedAtIso: string | undefined,
  ): Promise<{
    readonly signal: EventSourceSignal;
    readonly isNewIncident: boolean;
    readonly wasEmitted: boolean;
  }> {
    if (!this.deduplicator.shouldEmit(signal.resourceKey, nowMilliseconds)) {
      return { signal, isNewIncident: false, wasEmitted: false };
    }
    const result = this.channel.receiveEvent({
      kind: signal.kind as EventIncidentKind,
      resourceKey: signal.resourceKey,
      severity: signal.severity as EventSeverity,
      epoch: nowMilliseconds,
      receivedAtIso: receivedAtIso ?? new Date(nowMilliseconds).toISOString(),
    });
    const isNewIncident = result.outcome === "accepted" || result.outcome === "accepted-while-saturated";
    this.scheduleJournalWrite(nowMilliseconds);
    return { signal, isNewIncident, wasEmitted: true };
  }

  private scheduleJournalWrite(nowMilliseconds: number): void {
    if (this.journal === undefined) return;
    this.pendingJournalWrite = this.pendingJournalWrite
      .then(async () => {
        if (!this.hasLoadedJournalRevision) {
          const existing = await this.journal!.read().catch(() => ({ kind: "absent" as const }));
          this.journalRevision =
            existing.kind === "valid" ? existing.record.revision : 0;
          this.hasLoadedJournalRevision = true;
        }
        const saved = await this.journal!.save({
          snapshot: this.channel.toSnapshot(),
          expectedRevision: this.journalRevision,
          updatedAtIso: new Date(nowMilliseconds).toISOString(),
        });
        this.journalRevision = saved.revision;
      })
      .catch(() => {
        // 落盘失败不得阻塞业务；状态仍在内存里，下一次写入会再尝试。
      });
  }
}



