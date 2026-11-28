/**
 * TOKTRACE-01（2026-11-28）：**工具失败 → 下一次成功的 token 消耗与日志关联**。
 *
 * 背景（源码事实，见 `docs/tasks/TOKTRACE01_TOOL_FAILURE_TOKEN_TRACE.md`）：
 * - 运行历史记录工具成功/失败（工具名、脱敏原因、时间戳）；
 * - 用量账目记录每次 Provider 请求的真实 token（未知记 null，不补 0）；
 * - 两者互不关联 ⇒ 无法回答"这次失败到底烧了多少 token 才恢复"。
 *
 * 本模块做**纯时间轴关联**：
 * 1. 以 `(missionIdentifier, toolName)` 为窗口键，第一次失败开窗；
 * 2. 窗口内后续同工具失败并入（`failureCount` 累加，不另开窗）；
 * 3. 该工具下一次成功关窗并产出一条 trace；
 * 4. 窗口内**该 mission 的**全部 Provider 请求用量求和（请求可能同时服务其它调用，
 *    这里按"这段时间内该 mission 消耗的 token"统计，口径写进卡内）；
 * 5. 未关窗不产出 trace（只统计已收口窗口），并给出 `openWindowCount`；
 * 6. 非法时间戳 / 无法归属 mission 的用量事件 ⇒ `skippedEventCount` 计数，不静默丢。
 *
 * 纯函数：不读盘、不联网、不发事件。
 */

export type ToolActivityKind = "success" | "failure";

export interface ToolActivityEvent {
  readonly missionIdentifier: string;
  readonly toolName: string;
  readonly kind: ToolActivityKind;
  readonly recordedAtIso: string;
  readonly failureReason?: string | null;
}

export interface ProviderUsageObservationPoint {
  readonly missionIdentifier: string | null;
  readonly inputTokenCount: number | null;
  readonly outputTokenCount: number | null;
  readonly observedAtIso: string;
  readonly requestIdentifier?: string;
}

export type ToolFailureTokenTraceLogKind =
  | "tool-failure"
  | "provider-request"
  | "tool-success";

export interface ToolFailureTokenTraceLogEntry {
  readonly observedAtIso: string;
  readonly kind: ToolFailureTokenTraceLogKind;
  readonly detail: string;
  readonly inputTokenCount: number | null;
  readonly outputTokenCount: number | null;
}

export interface ToolFailureTokenTrace {
  readonly missionIdentifier: string;
  readonly toolName: string;
  readonly failureReason: string | null;
  readonly failedAtIso: string;
  readonly resolvedAtIso: string;
  readonly durationMilliseconds: number | null;
  readonly failureCount: number;
  readonly providerRequestCount: number;
  readonly inputTokenCount: number;
  readonly outputTokenCount: number;
  readonly totalTokenCount: number;
  readonly missingUsageRequestCount: number;
  readonly isComplete: boolean;
  readonly log: readonly ToolFailureTokenTraceLogEntry[];
}

export interface ToolFailureTokenTraceReport {
  readonly traces: ToolFailureTokenTrace[];
  /** 失败后未等到成功调用（窗口未收口）的数量。 */
  readonly openWindowCount: number;
  /** 时间戳非法 / 用量无法归属 mission 而被跳过的事件数。 */
  readonly skippedEventCount: number;
}

type TimelineEntry =
  | {
      readonly kind: "tool";
      readonly atMilliseconds: number;
      readonly order: number;
      readonly sequence: number;
      readonly event: ToolActivityEvent;
    }
  | {
      readonly kind: "usage";
      readonly atMilliseconds: number;
      readonly order: number;
      readonly sequence: number;
      readonly point: ProviderUsageObservationPoint;
    };

interface OpenWindow {
  readonly missionIdentifier: string;
  readonly toolName: string;
  readonly failedAtMilliseconds: number;
  readonly failureReason: string | null;
  failureCount: number;
  providerRequestCount: number;
  inputTokenCount: number;
  outputTokenCount: number;
  missingUsageRequestCount: number;
  log: ToolFailureTokenTraceLogEntry[];
}

function parseTime(iso: string): number | null {
  const milliseconds = Date.parse(iso);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function windowKey(missionIdentifier: string, toolName: string): string {
  return missionIdentifier + "\u0000" + toolName;
}

/**
 * 关联工具失败与后续用量。
 *
 * 排序纪律：按时间升序；同一时间戳按 `失败/成功(0) → 用量(1)` 排序，
 * 使"失败时刻的请求"归入窗口而"成功时刻的请求"仍可归入（成功先关窗，故不会重复计入）。
 */
export function buildToolFailureTokenTraces(input: {
  readonly toolEvents: readonly ToolActivityEvent[];
  readonly usageObservations: readonly ProviderUsageObservationPoint[];
}): ToolFailureTokenTraceReport {
  let skippedEventCount = 0;
  const timeline: TimelineEntry[] = [];
  let sequence = 0;

  for (const event of input.toolEvents) {
    const atMilliseconds = parseTime(event.recordedAtIso);
    if (atMilliseconds === null) {
      skippedEventCount += 1;
      continue;
    }
    timeline.push({
      kind: "tool",
      atMilliseconds,
      order: 0,
      sequence: sequence++,
      event,
    });
  }

  for (const point of input.usageObservations) {
    const atMilliseconds = parseTime(point.observedAtIso);
    if (atMilliseconds === null || point.missionIdentifier === null) {
      skippedEventCount += 1;
      continue;
    }
    timeline.push({
      kind: "usage",
      atMilliseconds,
      order: 1,
      sequence: sequence++,
      point,
    });
  }

  timeline.sort((left, right) => {
    if (left.atMilliseconds !== right.atMilliseconds) {
      return left.atMilliseconds - right.atMilliseconds;
    }
    if (left.order !== right.order) return left.order - right.order;
    return left.sequence - right.sequence;
  });

  const openWindows = new Map<string, OpenWindow>();
  const traces: ToolFailureTokenTrace[] = [];

  for (const entry of timeline) {
    if (entry.kind === "usage") {
      const point = entry.point;
      if (point.missionIdentifier === null) continue;
      for (const window of openWindows.values()) {
        if (window.missionIdentifier !== point.missionIdentifier) continue;
        window.providerRequestCount += 1;
        const inputTokens = point.inputTokenCount;
        const outputTokens = point.outputTokenCount;
        if (inputTokens === null || outputTokens === null) {
          window.missingUsageRequestCount += 1;
        }
        window.inputTokenCount += inputTokens ?? 0;
        window.outputTokenCount += outputTokens ?? 0;
        window.log.push({
          observedAtIso: point.observedAtIso,
          kind: "provider-request",
          detail:
            "provider 请求" +
            (point.requestIdentifier === undefined ? "" : "：" + point.requestIdentifier) +
            (inputTokens === null || outputTokens === null
              ? "（用量未知，总额不补 0）"
              : "（输入 " + String(inputTokens) + " / 输出 " + String(outputTokens) + "）"),
          inputTokenCount: inputTokens,
          outputTokenCount: outputTokens,
        });
      }
      continue;
    }

    const event = entry.event;
    const key = windowKey(event.missionIdentifier, event.toolName);
    if (event.kind === "failure") {
      const existing = openWindows.get(key);
      if (existing === undefined) {
        openWindows.set(key, {
          missionIdentifier: event.missionIdentifier,
          toolName: event.toolName,
          failedAtMilliseconds: entry.atMilliseconds,
          failureReason: event.failureReason ?? null,
          failureCount: 1,
          providerRequestCount: 0,
          inputTokenCount: 0,
          outputTokenCount: 0,
          missingUsageRequestCount: 0,
          log: [
            {
              observedAtIso: event.recordedAtIso,
              kind: "tool-failure",
              detail:
                "工具失败：" +
                event.toolName +
                (event.failureReason === undefined || event.failureReason === null
                  ? ""
                  : "（" + event.failureReason + "）"),
              inputTokenCount: null,
              outputTokenCount: null,
            },
          ],
        });
      } else {
        existing.failureCount += 1;
        existing.log.push({
          observedAtIso: event.recordedAtIso,
          kind: "tool-failure",
          detail:
            "工具再次失败：" +
            event.toolName +
            (event.failureReason === undefined || event.failureReason === null
              ? ""
              : "（" + event.failureReason + "）"),
          inputTokenCount: null,
          outputTokenCount: null,
        });
      }
      continue;
    }

    const window = openWindows.get(key);
    if (window === undefined) continue;
    openWindows.delete(key);
    const durationMilliseconds = entry.atMilliseconds - window.failedAtMilliseconds;
    const log = [
      ...window.log,
      {
        observedAtIso: event.recordedAtIso,
        kind: "tool-success" as const,
        detail: "工具成功：" + event.toolName,
        inputTokenCount: null,
        outputTokenCount: null,
      },
    ];
    traces.push({
      missionIdentifier: window.missionIdentifier,
      toolName: window.toolName,
      failureReason: window.failureReason,
      failedAtIso: new Date(window.failedAtMilliseconds).toISOString(),
      resolvedAtIso: event.recordedAtIso,
      durationMilliseconds: Number.isFinite(durationMilliseconds)
        ? durationMilliseconds
        : null,
      failureCount: window.failureCount,
      providerRequestCount: window.providerRequestCount,
      inputTokenCount: window.inputTokenCount,
      outputTokenCount: window.outputTokenCount,
      totalTokenCount: window.inputTokenCount + window.outputTokenCount,
      missingUsageRequestCount: window.missingUsageRequestCount,
      isComplete: window.missingUsageRequestCount === 0,
      log,
    });
  }

  traces.sort((left, right) => {
    if (left.failedAtIso !== right.failedAtIso) {
      return left.failedAtIso < right.failedAtIso ? -1 : 1;
    }
    if (left.toolName !== right.toolName) return left.toolName < right.toolName ? -1 : 1;
    return left.resolvedAtIso < right.resolvedAtIso ? -1 : 1;
  });

  return {
    traces,
    openWindowCount: openWindows.size,
    skippedEventCount,
  };
}

/**
 * 从运行历史文档中提取工具活动（只读解析；不改存储格式）。
 *
 * 只认 `tool-call`（成功）与 `tool-failure`（失败）；`payloadJson` 损坏的记录跳过并计数。
 */
export function extractToolActivityEvents(document: {
  readonly missionIdentifier: string;
  readonly segments: ReadonlyArray<{
    readonly events: ReadonlyArray<{
      readonly kind: string;
      readonly recordedAtIso: string;
      readonly payloadJson: string;
    }>;
  }>;
}): { readonly events: ToolActivityEvent[]; readonly skippedEventCount: number } {
  const events: ToolActivityEvent[] = [];
  let skippedEventCount = 0;
  for (const segment of document.segments) {
    for (const event of segment.events) {
      if (event.kind !== "tool-call" && event.kind !== "tool-failure") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(event.payloadJson);
      } catch {
        skippedEventCount += 1;
        continue;
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        skippedEventCount += 1;
        continue;
      }
      const record = payload as Record<string, unknown>;
      const toolName = record["toolName"];
      if (typeof toolName !== "string" || toolName === "") {
        skippedEventCount += 1;
        continue;
      }
      const failureReason = record["failureReason"];
      events.push({
        missionIdentifier: document.missionIdentifier,
        toolName,
        kind: event.kind === "tool-call" ? "success" : "failure",
        recordedAtIso: event.recordedAtIso,
        failureReason: typeof failureReason === "string" ? failureReason : null,
      });
    }
  }
  return { events, skippedEventCount };
}
