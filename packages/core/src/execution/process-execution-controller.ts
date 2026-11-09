/**
 * EXEC-01-01/03（2026-11-09）：**受控进程执行控制器**。
 *
 * 职责边界（刻意收窄）：
 * - 本文件**不启动进程**：真实隔离由注入的 `SandboxExecutionBackend` 负责（EXEC-01-02）。
 *   没有可用后端时返回 `execution-backend-unsupported`，**不伪装成功**。
 * - 本文件负责：环境解析、参数越界判定、幂等、归属校验、状态机与输出游标。
 * - 首版非交互（stdin 关闭）、有限时长、网络禁止。
 */
import { DomainError } from "../core/errors.js";
import { redactSensitiveText } from "../orchestration/diagnostic-event-store.js";
import type {
  ExecutionEnvironmentRegistry,
  ProcessExecutionIdentity,
  ProcessExecutionOwnership,
  ProcessExecutionStartRequest,
  ProcessExecutionStatus,
  ProcessExecutionTerminationKind,
} from "./execution-contract.js";
import {
  buildProcessExecutionIdentity,
  PROCESS_EXECUTION_DEFAULT_TIMEOUT_MILLISECONDS,
} from "./execution-contract.js";

/** readOutput 单次有界输出：默认 32 KiB，最大 128 KiB（§03）。 */
export const PROCESS_EXECUTION_DEFAULT_OUTPUT_READ_BYTES = 32 * 1024;
export const PROCESS_EXECUTION_MAXIMUM_OUTPUT_READ_BYTES = 128 * 1024;
/** 单流存储上限默认 8 MiB；超限标记截断，不把截断当成功（§03）。 */
export const PROCESS_EXECUTION_DEFAULT_STREAM_STORAGE_LIMIT_BYTES = 8 * 1024 * 1024;

/** 后端能力探测结果：不可用时必须给出具体原因，不得只说 false。 */
export interface SandboxCapabilityProfile {
  readonly isAvailable: boolean;
  readonly backendIdentifier: string;
  readonly isolationPrimitiveDescription: string;
  readonly reasonUnavailable: string | null;
}

export interface SandboxStartOutcome {
  readonly backendExecutionHandle: string;
  readonly status: Extract<ProcessExecutionStatus, "queued" | "running">;
}

export interface SandboxExecutionSnapshot {
  readonly status: ProcessExecutionStatus;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
}

export interface SandboxOutputStreamChunk {
  readonly text: string;
  readonly nextCursorBytes: number;
  readonly isTruncated: boolean;
}

/**
 * 隔离后端端口（EXEC-01-02 提供真实实现）。
 *
 * 注意：这个接口的存在**不**代表已有沙箱。`probeCapability()` 为 false 时
 * 上层必须返回精确 unsupported。
 */
export interface SandboxExecutionBackend {
  probeCapability(): Promise<SandboxCapabilityProfile>;
  start(input: {
    readonly identity: ProcessExecutionIdentity;
    readonly executableEntryPoint: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly timeoutMilliseconds: number;
    readonly streamStorageLimitBytes: number;
  }): Promise<SandboxStartOutcome>;
  readStatus(backendExecutionHandle: string): Promise<SandboxExecutionSnapshot>;
  readOutputStream(input: {
    readonly backendExecutionHandle: string;
    readonly stream: "stdout" | "stderr";
    readonly fromCursorBytes: number;
    readonly maximumBytes: number;
  }): Promise<SandboxOutputStreamChunk>;
  cancel(backendExecutionHandle: string, reason: string): Promise<SandboxExecutionSnapshot>;
}

export interface ProcessExecutionRecord {
  readonly identity: ProcessExecutionIdentity;
  readonly request: ProcessExecutionStartRequest;
  readonly executableEntryPoint: string;
  status: ProcessExecutionStatus;
  backendExecutionHandle: string | null;
  exitCode: number | null;
  failureReason: string | null;
  /**
   * 终止原因分类（EXEC-01-03）。旧记录没有该字段 ⇒ 读回时按 `null` 处理，
   * **不猜测**它是取消还是失败。
   */
  terminationKind?: ProcessExecutionTerminationKind | null;
  readonly queuedAtIso: string;
  startedAtIso: string | null;
  finishedAtIso: string | null;
  readonly stdoutCursorBytes: number;
  readonly stderrCursorBytes: number;
}

export interface ProcessExecutionStore {
  read(executionId: string): Promise<ProcessExecutionRecord | null>;
  readByIdempotencyKey(input: {
    readonly agentInstanceIdentifier: string;
    readonly idempotencyKey: string;
  }): Promise<ProcessExecutionRecord | null>;
  write(record: ProcessExecutionRecord): Promise<void>;
}

/** 默认内存实现（持久化与重启对账属于 EXEC-01-03）。 */
export class InMemoryProcessExecutionStore implements ProcessExecutionStore {
  private readonly recordsById = new Map<string, ProcessExecutionRecord>();
  private readonly executionIdsByIdempotencyKey = new Map<string, string>();

  async read(executionId: string): Promise<ProcessExecutionRecord | null> {
    return this.recordsById.get(executionId) ?? null;
  }

  async readByIdempotencyKey(input: {
    readonly agentInstanceIdentifier: string;
    readonly idempotencyKey: string;
  }): Promise<ProcessExecutionRecord | null> {
    const executionId = this.executionIdsByIdempotencyKey.get(
      `${input.agentInstanceIdentifier}\u0000${input.idempotencyKey}`,
    );
    return executionId === undefined ? null : (this.recordsById.get(executionId) ?? null);
  }

  async write(record: ProcessExecutionRecord): Promise<void> {
    this.recordsById.set(record.identity.executionId, record);
    const idempotencyKey = record.request.idempotencyKey;
    if (idempotencyKey !== undefined) {
      this.executionIdsByIdempotencyKey.set(
        `${record.identity.agentInstanceIdentifier}\u0000${idempotencyKey}`,
        record.identity.executionId,
      );
    }
  }
}

export interface ProcessExecutionControllerOptions {
  readonly environmentRegistry: ExecutionEnvironmentRegistry;
  readonly store?: ProcessExecutionStore;
  /** 缺省 null ⇒ 一律 `execution-backend-unsupported`（不静默降级到宿主执行）。 */
  readonly sandboxBackend?: SandboxExecutionBackend | null;
  /**
   * 上级可管理判定（"明确授权的上级"）。
   * 缺省 null ⇒ 只有**同一主体**能查询/读取/取消自己的执行。
   */
  readonly isSuperiorAgentAuthorizedToManage?: (input: {
    readonly requestingAgentInstanceIdentifier: string;
    readonly ownerAgentInstanceIdentifier: string;
  }) => boolean;
  readonly nowIso?: () => string;
  readonly generateExecutionId?: () => string;
}

export interface ProcessExecutionStartResult {
  readonly executionId: string;
  readonly status: ProcessExecutionStatus;
  readonly isReusedByIdempotencyKey: boolean;
}

export interface ProcessExecutionStatusResult {
  readonly executionId: string;
  readonly status: ProcessExecutionStatus;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
  readonly environmentIdentifier: string;
  readonly queuedAtIso: string;
  readonly startedAtIso: string | null;
  readonly finishedAtIso: string | null;
  /** EXEC-01-03：终止原因分类（`null` = 尚未终止，或旧记录未记录）。 */
  readonly terminationKind: ProcessExecutionTerminationKind | null;
}

export interface ProcessExecutionOutputResult {
  readonly executionId: string;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly nextCursorBytes: number;
  readonly isTruncated: boolean;
  readonly isStreamStorageLimitReached: boolean;
  /**
   * 本次读取是否发生了敏感内容替换（`false` = 未发现，不是"没有扫描"）。
   *
   * 只报事实，不报"发现了什么"：把命中的凭据类型回传给调用方等于二次泄漏。
   */
  readonly isSensitiveContentRedacted: boolean;
}

export class ProcessExecutionController {
  private readonly environmentRegistry: ExecutionEnvironmentRegistry;
  private readonly store: ProcessExecutionStore;
  private readonly sandboxBackend: SandboxExecutionBackend | null;
  private readonly isSuperiorAgentAuthorizedToManage:
    | ProcessExecutionControllerOptions["isSuperiorAgentAuthorizedToManage"]
    | null;
  private readonly nowIso: () => string;
  private readonly generateExecutionId: (() => string) | undefined;

  constructor(options: ProcessExecutionControllerOptions) {
    this.environmentRegistry = options.environmentRegistry;
    this.store = options.store ?? new InMemoryProcessExecutionStore();
    this.sandboxBackend = options.sandboxBackend ?? null;
    this.isSuperiorAgentAuthorizedToManage =
      options.isSuperiorAgentAuthorizedToManage ?? null;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.generateExecutionId = options.generateExecutionId;
  }

  /** 后端能力探测（供装配自检与分诊使用；不启动进程）。 */
  async probeBackendCapability(): Promise<SandboxCapabilityProfile> {
    if (this.sandboxBackend === null) {
      return {
        isAvailable: false,
        backendIdentifier: "none",
        isolationPrimitiveDescription: "未装配隔离后端",
        reasonUnavailable:
          "未装配沙箱执行后端：拒绝执行（不降级到宿主进程执行）",
      };
    }
    return this.sandboxBackend.probeCapability();
  }

  /**
   * start：非交互、受限、有限时长。
   *
   * `remainingTaskBudgetMilliseconds` 由任务预算注入；实际超时取
   * `min(请求值, 任务剩余预算)`（§01"仍取任务剩余预算更严值"）。
   */
  async start(input: {
    readonly ownership: ProcessExecutionOwnership;
    readonly request: ProcessExecutionStartRequest;
    readonly remainingTaskBudgetMilliseconds?: number | null;
  }): Promise<ProcessExecutionStartResult> {
    /**
     * EXEC-01-04：**先探后端，再查环境**。
     *
     * 顺序有讲究：没有可用隔离后端是平台级前提，比"环境标识写错"更根本；
     * 反过来先报"环境不存在"会把"这台机器根本没装沙箱"误导成配置问题。
     */
    const capabilityFirst = await this.probeBackendCapability();
    if (!capabilityFirst.isAvailable || this.sandboxBackend === null) {
      throw new DomainError(
        "execution-backend-unsupported",
        `当前平台没有可用的隔离执行后端：${String(capabilityFirst.reasonUnavailable ?? "未知原因")}`,
      );
    }
    const environmentEntry = this.environmentRegistry.get(
      input.request.environmentIdentifier,
    );
    if (environmentEntry === null) {
      throw new DomainError(
        "execution-environment-not-found",
        `未登记的执行环境：${input.request.environmentIdentifier}（不得临时创建环境）`,
      );
    }
    const executableEntryPoint =
      environmentEntry.policy.executableIdentifiers[input.request.executableIdentifier];
    if (executableEntryPoint === undefined) {
      throw new DomainError(
        "execution-request-invalid",
        `执行环境 ${environmentEntry.policy.environmentIdentifier} 未登记可执行标识：${input.request.executableIdentifier}`,
      );
    }
    this.assertWorkingDirectoryInsideInputScope(
      input.request.workingDirectory,
      environmentEntry.policy.allowedInputProjectRelativePrefixes,
    );

    /** 幂等：同键同参返回原执行，异参拒绝（不重启进程）。 */
    const idempotencyKey = input.request.idempotencyKey;
    if (idempotencyKey !== undefined) {
      /**
       * EXEC-01-03：**毒化键优先**。
       *
       * 重启对账若无法确认某次执行是否真的跑过，该幂等键会被毒化；
       * 此后再用同一个键启动，可能重复副作用 ⇒ 必须拒绝，且**不**回退到"新建执行"。
       */
      const poisonedCheck = this.store as unknown as {
        isIdempotencyKeyPoisoned?: (input: {
          readonly agentInstanceIdentifier: string;
          readonly idempotencyKey: string;
        }) => Promise<boolean>;
      };
      if (typeof poisonedCheck.isIdempotencyKeyPoisoned === "function") {
        const isPoisoned = await poisonedCheck.isIdempotencyKeyPoisoned({
          agentInstanceIdentifier: input.ownership.agentInstanceIdentifier,
          idempotencyKey,
        });
        if (isPoisoned) {
          throw new DomainError(
            "execution-idempotency-conflict",
            `幂等键 ${idempotencyKey} 的副作用可能已经发生（重启对账不确定）：拒绝复用启动新执行`,
          );
        }
      }
      const existing = await this.store.readByIdempotencyKey({
        agentInstanceIdentifier: input.ownership.agentInstanceIdentifier,
        idempotencyKey,
      });
      if (existing !== null) {
        const candidateIdentity = buildProcessExecutionIdentity({
          ownership: input.ownership,
          request: input.request,
          environmentFingerprint: environmentEntry.fingerprint,
          ...(this.generateExecutionId === undefined
            ? {}
            : { generateExecutionId: this.generateExecutionId }),
        });
        if (candidateIdentity.requestFingerprint !== existing.identity.requestFingerprint) {
          throw new DomainError(
            "execution-idempotency-conflict",
            `幂等键 ${idempotencyKey} 已用于不同参数：拒绝复用（不重启进程）`,
          );
        }
        return {
          executionId: existing.identity.executionId,
          status: existing.status,
          isReusedByIdempotencyKey: true,
        };
      }
    }

    const identity = buildProcessExecutionIdentity({
      ownership: input.ownership,
      request: input.request,
      environmentFingerprint: environmentEntry.fingerprint,
      ...(this.generateExecutionId === undefined
        ? {}
        : { generateExecutionId: this.generateExecutionId }),
    });
    const timeoutMilliseconds = this.resolveTimeoutMilliseconds(
      input.request.timeoutMilliseconds ?? PROCESS_EXECUTION_DEFAULT_TIMEOUT_MILLISECONDS,
      input.remainingTaskBudgetMilliseconds ?? null,
    );

    const queuedAtIso = this.nowIso();
    const record: ProcessExecutionRecord = {
      identity,
      request: input.request,
      executableEntryPoint,
      status: "queued",
      backendExecutionHandle: null,
      exitCode: null,
      failureReason: null,
      queuedAtIso,
      startedAtIso: null,
      finishedAtIso: null,
      stdoutCursorBytes: 0,
      stderrCursorBytes: 0,
    };
    await this.store.write(record);

    const started = await this.sandboxBackend.start({
      identity,
      executableEntryPoint,
      arguments: input.request.arguments,
      workingDirectory: input.request.workingDirectory,
      timeoutMilliseconds,
      streamStorageLimitBytes: PROCESS_EXECUTION_DEFAULT_STREAM_STORAGE_LIMIT_BYTES,
    });
    const runningRecord: ProcessExecutionRecord = {
      ...record,
      status: started.status,
      backendExecutionHandle: started.backendExecutionHandle,
      startedAtIso: this.nowIso(),
    };
    await this.store.write(runningRecord);
    return {
      executionId: identity.executionId,
      status: runningRecord.status,
      isReusedByIdempotencyKey: false,
    };
  }

  async readStatus(input: {
    readonly requestingAgentInstanceIdentifier: string;
    readonly executionId: string;
  }): Promise<ProcessExecutionStatusResult> {
    const record = await this.requireAccessibleRecord(input);
    const refreshed = await this.refreshFromBackend(record);
    return {
      executionId: refreshed.identity.executionId,
      status: refreshed.status,
      exitCode: refreshed.exitCode,
      failureReason: refreshed.failureReason,
      environmentIdentifier: refreshed.identity.environmentIdentifier,
      queuedAtIso: refreshed.queuedAtIso,
      startedAtIso: refreshed.startedAtIso,
      finishedAtIso: refreshed.finishedAtIso,
      terminationKind: refreshed.terminationKind ?? null,
    };
  }

  async readOutput(input: {
    readonly requestingAgentInstanceIdentifier: string;
    readonly executionId: string;
    readonly stream: "stdout" | "stderr";
    readonly fromCursorBytes: number;
    readonly maximumBytes?: number;
  }): Promise<ProcessExecutionOutputResult> {
    const record = await this.requireAccessibleRecord(input);
    if (record.backendExecutionHandle === null) {
      throw new DomainError(
        "execution-not-found",
        `执行 ${input.executionId} 尚未启动，暂无输出`,
      );
    }
    if (
      !Number.isInteger(input.fromCursorBytes) ||
      input.fromCursorBytes < 0
    ) {
      throw new DomainError(
        "execution-request-invalid",
        "输出游标必须是非负整数（字节）",
      );
    }
    const maximumBytes = Math.min(
      Math.max(
        1,
        input.maximumBytes ?? PROCESS_EXECUTION_DEFAULT_OUTPUT_READ_BYTES,
      ),
      PROCESS_EXECUTION_MAXIMUM_OUTPUT_READ_BYTES,
    );
    if (this.sandboxBackend === null) {
      throw new DomainError(
        "execution-backend-unsupported",
        "未装配沙箱执行后端：无法读取输出",
      );
    }
    const chunk = await this.sandboxBackend.readOutputStream({
      backendExecutionHandle: record.backendExecutionHandle,
      stream: input.stream,
      fromCursorBytes: input.fromCursorBytes,
      maximumBytes,
    });
    /**
     * EXEC-01-03：**返回前的敏感扫描门禁**。
     *
     * 为什么放在控制器而不是各自调用方：工具路径与 SDK 路径都会读输出，
     * 只在其中一处脱敏就等于另一处照原样外泄（实测过同类问题：运行历史
     * 曾"先落盘再在展示层遮挡"）。这里统一在**离开控制器之前**扫描并替换，
     * 同时如实回报"是否发生了替换"，供诊断区分"没有敏感内容"与"已遮挡"。
     */
    const redactedText = redactSensitiveText(chunk.text);
    const isSensitiveContentRedacted = redactedText !== chunk.text;
    return {
      executionId: record.identity.executionId,
      stream: input.stream,
      text: redactedText,
      nextCursorBytes: chunk.nextCursorBytes,
      isTruncated: chunk.isTruncated,
      isStreamStorageLimitReached: chunk.isTruncated,
      isSensitiveContentRedacted,
    };
  }

  async cancel(input: {
    readonly requestingAgentInstanceIdentifier: string;
    readonly executionId: string;
    readonly reason: string;
    /**
     * 终止原因分类（缺省 `caller-cancelled`）。
     *
     * 权限撤销必须与调用方取消**分开**：前者不允许自动重试，后者允许。
     * 调用方自述不足以为证，因此该值只由受信控制面传入。
     */
    readonly terminationKind?: ProcessExecutionTerminationKind;
  }): Promise<ProcessExecutionStatusResult> {
    const record = await this.requireAccessibleRecord(input);
    if (this.sandboxBackend === null || record.backendExecutionHandle === null) {
      throw new DomainError(
        "execution-backend-unsupported",
        "未装配沙箱执行后端：无法取消",
      );
    }
    const snapshot = await this.sandboxBackend.cancel(
      record.backendExecutionHandle,
      input.reason,
    );
    const cancelledRecord: ProcessExecutionRecord = {
      ...record,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
      failureReason: snapshot.failureReason ?? input.reason,
      terminationKind: input.terminationKind ?? "caller-cancelled",
      finishedAtIso: this.nowIso(),
    };
    await this.store.write(cancelledRecord);
    return {
      executionId: cancelledRecord.identity.executionId,
      status: cancelledRecord.status,
      exitCode: cancelledRecord.exitCode,
      failureReason: cancelledRecord.failureReason,
      environmentIdentifier: cancelledRecord.identity.environmentIdentifier,
      queuedAtIso: cancelledRecord.queuedAtIso,
      startedAtIso: cancelledRecord.startedAtIso,
      finishedAtIso: cancelledRecord.finishedAtIso,
      terminationKind: cancelledRecord.terminationKind ?? null,
    };
  }

  private assertWorkingDirectoryInsideInputScope(
    workingDirectory: string,
    allowedPrefixes: readonly string[],
  ): void {
    const normalized = workingDirectory.replace(/\\/gu, "/").replace(/^\.\//u, "");
    const isInside = allowedPrefixes.some((prefix) => {
      const normalizedPrefix = prefix.replace(/\\/gu, "/").replace(/\/$/u, "");
      return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
    });
    if (!isInside) {
      throw new DomainError(
        "execution-request-invalid",
        `workingDirectory 不在该环境的输入范围内：${workingDirectory}`,
      );
    }
  }

  private resolveTimeoutMilliseconds(
    requestedTimeoutMilliseconds: number,
    remainingTaskBudgetMilliseconds: number | null,
  ): number {
    if (
      remainingTaskBudgetMilliseconds !== null &&
      remainingTaskBudgetMilliseconds > 0 &&
      remainingTaskBudgetMilliseconds < requestedTimeoutMilliseconds
    ) {
      return remainingTaskBudgetMilliseconds;
    }
    return requestedTimeoutMilliseconds;
  }

  private async requireAccessibleRecord(input: {
    readonly requestingAgentInstanceIdentifier: string;
    readonly executionId: string;
  }): Promise<ProcessExecutionRecord> {
    const record = await this.store.read(input.executionId);
    if (record === null) {
      throw new DomainError(
        "execution-not-found",
        `执行不存在：${input.executionId}`,
      );
    }
    const isOwner =
      record.identity.agentInstanceIdentifier ===
      input.requestingAgentInstanceIdentifier;
    if (!isOwner) {
      const isSuperior =
        this.isSuperiorAgentAuthorizedToManage?.({
          requestingAgentInstanceIdentifier: input.requestingAgentInstanceIdentifier,
          ownerAgentInstanceIdentifier: record.identity.agentInstanceIdentifier,
        }) === true;
      if (!isSuperior) {
        throw new DomainError(
          "execution-not-authorized",
          `无权访问该执行：${input.executionId}（既非本主体，也未获上级管理授权）`,
        );
      }
    }
    return record;
  }

  private async refreshFromBackend(
    record: ProcessExecutionRecord,
  ): Promise<ProcessExecutionRecord> {
    if (record.backendExecutionHandle === null || this.sandboxBackend === null) {
      return record;
    }
    if (
      record.status === "succeeded" ||
      record.status === "failed" ||
      record.status === "cancelled" ||
      record.status === "timed-out"
    ) {
      return record;
    }
    const snapshot = await this.sandboxBackend.readStatus(record.backendExecutionHandle);
    if (
      snapshot.status === record.status &&
      snapshot.exitCode === record.exitCode &&
      snapshot.failureReason === record.failureReason
    ) {
      return record;
    }
    const isTerminal =
      snapshot.status === "succeeded" ||
      snapshot.status === "failed" ||
      snapshot.status === "cancelled" ||
      snapshot.status === "timed-out" ||
      snapshot.status === "unknown";
    const updated: ProcessExecutionRecord = {
      ...record,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
      failureReason: snapshot.failureReason,
      /**
       * EXEC-01-03：终止原因**由后端状态推导**，不由调用方自述。
       * 只有 `timed-out` / `failed` 能从状态本身确定；`cancelled` 需要区分
       * "调用方取消"与"权限撤销"，因此**不在**这里推断（由 cancel 路径显式设置）。
       */
      terminationKind:
        snapshot.status === "timed-out"
          ? "timed-out"
          : snapshot.status === "failed"
            ? "backend-failed"
            : (record.terminationKind ?? null),
      finishedAtIso: isTerminal ? (record.finishedAtIso ?? this.nowIso()) : null,
    };
    await this.store.write(updated);
    return updated;
  }
}
