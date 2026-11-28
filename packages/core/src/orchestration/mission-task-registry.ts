import { createHash } from "node:crypto";

/**
 * MISSION-WRITE-01 切片 1（2026-11-28）：**任务记录与幂等账本的状态容器 + 纯幂等判定**。
 *
 * 背景：`submitTask` 的幂等 claim 是"查账目 → 判同键异参 → 登记 pending claim"，
 * 埋在 421 行的门面方法里，且与任务表、会话校验、指令窗口共享状态，无法单测。
 *
 * 本模块只提供两类东西：
 * 1. **纯函数** `evaluateIdempotentSubmission`：给定账目条目与任务记录存在性，返回判定结果；
 * 2. **状态容器** `MissionTaskRegistry`：任务记录 + 幂等账目的内存表（get/set/删除/枚举），
 *    **不含**错误策略、事件发射与落盘 —— 那些仍由门面/后续切片负责。
 *
 * 纪律：纯函数不做 I/O；容器不抛业务错误；错误码与文案仍由调用方决定（保持逐字兼容）。
 */

export interface MissionTaskIdempotencyEntry {
  readonly sessionIdentifier: string;
  readonly idempotencyKey: string;
  /** 规范化完整参数哈希（同键异参据此拒绝）。 */
  readonly inputHash: string;
  readonly taskIdentifier: string;
  readonly missionIdentifier: string | null;
  readonly claimedAtIso: string;
  readonly settledAtIso: string | null;
}

/** 幂等账目键：同一会话内按 idempotencyKey 隔离（跨会话互不复用）。 */
export function resolveIdempotencyLedgerKey(sessionIdentifier: string, idempotencyKey: string): string {
  return sessionIdentifier + "|" + idempotencyKey;
}

/**
 * 规范化**任务内容**哈希（同键异参据此拒绝）。
 *
 * 只纳入任务内容（prompt 与执行归属参数）：`taskIdentifier` 是本地受理标识，
 * 不同标识但同内容属同一逻辑请求；改内容则是不同参数 → 拒绝。
 */
export function computeTaskSubmissionInputHash(input: {
  readonly prompt: string;
  readonly projectIdentifier?: string;
  readonly workspaceRootPath?: string;
  readonly targetAgentInstanceIdentifier?: string;
}): string {
  /** 调用方（public-sdk）已依赖 node:crypto；这里保持同一实现（逐字兼容）。 */
  return createHash("sha256")
    .update(
      input.prompt +
        "\u0000" +
        (input.projectIdentifier ?? "") +
        "\u0000" +
        (input.workspaceRootPath ?? "") +
        "\u0000" +
        (input.targetAgentInstanceIdentifier ?? ""),
    )
    .digest("hex");
}

export type IdempotentSubmissionOutcome =
  | { readonly kind: "no-idempotency-key" }
  | { readonly kind: "conflict"; readonly entry: MissionTaskIdempotencyEntry }
  | { readonly kind: "claim-pending"; readonly entry: MissionTaskIdempotencyEntry }
  | {
      readonly kind: "reuse-settled";
      readonly entry: MissionTaskIdempotencyEntry;
      readonly hasTaskRecord: boolean;
    }
  | { readonly kind: "claim"; readonly ledgerKey: string };

/**
 * 幂等判定（纯函数）：
 * - 无幂等键 ⇒ `no-idempotency-key`；
 * - 同键异参 ⇒ `conflict`（调用方抛 `idempotency-key-conflict`）；
 * - 同键同参且未结算（missionIdentifier 为 null）⇒ `claim-pending`（不重复执行、不假定成功）；
 * - 同键同参且已结算 ⇒ `reuse-settled`（有任务记录就投影，否则回 accepted 骨架）；
 * - 未命中 ⇒ `claim`（调用方登记 pending 并落盘）。
 */
export function evaluateIdempotentSubmission(input: {
  readonly sessionId: string;
  readonly idempotencyKey?: string;
  readonly inputHash: string;
  readonly findEntry: (ledgerKey: string) => MissionTaskIdempotencyEntry | undefined;
  readonly hasTaskRecord: (taskIdentifier: string) => boolean;
}): IdempotentSubmissionOutcome {
  if (input.idempotencyKey === undefined) {
    return { kind: "no-idempotency-key" };
  }
  const ledgerKey = resolveIdempotencyLedgerKey(input.sessionId, input.idempotencyKey);
  const existingEntry = input.findEntry(ledgerKey);
  if (existingEntry === undefined) {
    return { kind: "claim", ledgerKey };
  }
  if (existingEntry.inputHash !== input.inputHash) {
    return { kind: "conflict", entry: existingEntry };
  }
  if (existingEntry.missionIdentifier === null) {
    return { kind: "claim-pending", entry: existingEntry };
  }
  return {
    kind: "reuse-settled",
    entry: existingEntry,
    hasTaskRecord: input.hasTaskRecord(existingEntry.taskIdentifier),
  };
}

/**
 * 任务记录 + 幂等账目的**内存状态容器**（不含业务错误与事件）。
 *
 * 记录类型保持泛型：切片 1 只搬运存储职责，记录字段仍由门面定义。
 */
export class MissionTaskRegistry<TRecord> {
  private readonly recordsByTaskIdentifier = new Map<string, TRecord>();
  private readonly idempotencyEntries = new Map<string, MissionTaskIdempotencyEntry>();

  constructor(input: {
    readonly taskRecords?: ReadonlyArray<readonly [string, TRecord]>;
    readonly idempotencyEntries?: ReadonlyArray<MissionTaskIdempotencyEntry>;
  } = {}) {
    for (const [taskIdentifier, record] of input.taskRecords ?? []) {
      this.recordsByTaskIdentifier.set(taskIdentifier, record);
    }
    for (const entry of input.idempotencyEntries ?? []) {
      this.idempotencyEntries.set(
        resolveIdempotencyLedgerKey(entry.sessionIdentifier, entry.idempotencyKey),
        entry,
      );
    }
  }

  findTaskRecord(taskIdentifier: string): TRecord | undefined {
    return this.recordsByTaskIdentifier.get(taskIdentifier);
  }

  upsertTaskRecord(taskIdentifier: string, record: TRecord): void {
    this.recordsByTaskIdentifier.set(taskIdentifier, record);
  }

  deleteTaskRecord(taskIdentifier: string): boolean {
    return this.recordsByTaskIdentifier.delete(taskIdentifier);
  }

  listTaskRecords(): Array<readonly [string, TRecord]> {
    return [...this.recordsByTaskIdentifier.entries()];
  }

  findIdempotencyEntry(sessionIdentifier: string, idempotencyKey: string): MissionTaskIdempotencyEntry | undefined {
    return this.idempotencyEntries.get(resolveIdempotencyLedgerKey(sessionIdentifier, idempotencyKey));
  }

  recordIdempotencyEntry(entry: MissionTaskIdempotencyEntry): void {
    this.idempotencyEntries.set(
      resolveIdempotencyLedgerKey(entry.sessionIdentifier, entry.idempotencyKey),
      entry,
    );
  }

  listIdempotencyEntries(): MissionTaskIdempotencyEntry[] {
    return [...this.idempotencyEntries.values()];
  }
}

export type ExistingTaskSubmissionOutcome =
  | { readonly kind: "absent" }
  | { readonly kind: "reuse" }
  | { readonly kind: "session-mismatch" };

/**
 * 已存在同 taskIdentifier 时的提交判定（纯函数）：
 * - 不存在 ⇒ absent（继续创建流程）；
 * - 同会话 ⇒ reuse（投影既有记录，不重复创建）；
 * - 跨会话 ⇒ session-mismatch（调用方抛既有文案）。
 */
export function evaluateExistingTaskForSubmission(input: {
  readonly requestedSessionId: string;
  readonly existingTaskSessionId?: string;
}): ExistingTaskSubmissionOutcome {
  if (input.existingTaskSessionId === undefined) return { kind: "absent" };
  if (input.existingTaskSessionId !== input.requestedSessionId) {
    return { kind: "session-mismatch" };
  }
  return { kind: "reuse" };
}
