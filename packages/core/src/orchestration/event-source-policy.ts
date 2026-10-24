/**
 * EVENT-01（2026-10-24，用户"按建议做"）：**生产事件源策略**。
 *
 * 用户确认的口径：
 * - 信号：①工具崩溃类错误 ⇒ `tool-crash` / **critical**；②**连续 3 次** provider 失败 ⇒ `provider-failure` / high；
 *   普通工具报错**不算**事故（不把等待/拒绝/普通失败记成紧急事件）；
 * - 去重：同一资源键 **60 秒**内只发一次（合并窗口）；
 * - 默认开启（只在上述信号触发）；
 * - 响应期限 60s、超期降级、恢复需用户确认（沿用仲裁内核）。
 */
import type { EventIncidentKind, EventSeverity } from "./event-incident-arbitration.js";

/** 连续 provider 失败阈值（用户口径 3 次）。 */
export const PROVIDER_FAILURE_THRESHOLD = 3;
/** 同键去重窗口（秒）。 */
export const EVENT_SOURCE_MERGE_WINDOW_SECONDS = 60;

/** 崩溃类错误特征（只匹配明确表示进程/资源崩溃的错误，不把普通业务失败算进来）。 */
const CRASH_LIKE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bEPIPE\b/,
  /\bENOMEM\b/,
  /\bEMFILE\b/,
  /\bEIO\b/,
  /\bECONNRESET\b/,
  /\bSIGSEGV\b/,
  /\bSIGKILL\b/,
  /\bSIGABRT\b/,
  /\bspawn\b/i,
  /\bcrash(ed)?\b/i,
  /进程.*(崩溃|异常退出)/,
  /工具.*(崩溃|无法启动)/,
];

/** 判断一次工具失败是否算"崩溃类"。 */
export function isCrashLikeToolFailure(failureReason: string): boolean {
  return CRASH_LIKE_PATTERNS.some((pattern) => pattern.test(failureReason));
}

export interface EventSourceSignal {
  readonly kind: EventIncidentKind;
  readonly severity: EventSeverity;
  readonly resourceKey: string;
  readonly reason: string;
}

/** 同键去重（60 秒窗口）。 */
export class EventSourceDeduplicator {
  private readonly lastSignalAtByKey = new Map<string, number>();
  private readonly mergeWindowMilliseconds: number;

  constructor(mergeWindowSeconds: number = EVENT_SOURCE_MERGE_WINDOW_SECONDS) {
    this.mergeWindowMilliseconds = mergeWindowSeconds * 1000;
  }

  /** 返回 true 表示可以发出（未在窗口内）；false 表示窗口内已发过。 */
  shouldEmit(resourceKey: string, nowMilliseconds: number): boolean {
    const last = this.lastSignalAtByKey.get(resourceKey);
    if (last !== undefined && nowMilliseconds - last < this.mergeWindowMilliseconds) {
      return false;
    }
    this.lastSignalAtByKey.set(resourceKey, nowMilliseconds);
    return true;
  }
}

/** 连续 provider 失败计数（成功即清零）。 */
export class ProviderFailureCounter {
  private consecutiveFailureCountByKey = new Map<string, number>();

  onFailure(resourceKey: string): { readonly shouldSignal: boolean; readonly consecutiveFailureCount: number } {
    const next = (this.consecutiveFailureCountByKey.get(resourceKey) ?? 0) + 1;
    this.consecutiveFailureCountByKey.set(resourceKey, next);
    return { shouldSignal: next >= PROVIDER_FAILURE_THRESHOLD, consecutiveFailureCount: next };
  }

  onSuccess(resourceKey: string): void {
    this.consecutiveFailureCountByKey.delete(resourceKey);
  }
}

/** 判断一次工具失败是否应该产生事故信号。 */
export function evaluateToolFailureSignal(input: {
  readonly toolName: string;
  readonly failureReason: string;
}): EventSourceSignal | null {
  if (!isCrashLikeToolFailure(input.failureReason)) return null;
  return {
    kind: "tool-crash",
    severity: "critical",
    resourceKey: "tool:" + input.toolName,
    reason: "工具崩溃类错误：`" + input.toolName + "` — " + input.failureReason,
  };
}
