/**
 * EXEC-01-01（2026-11-09）：**受控进程执行的运行环境与执行契约**。
 *
 * 本文件只做"契约与判定"，不启动任何进程 —— 真实隔离后端属于 EXEC-01-02。
 * 这样划分是为了避免把"参数校验通过"误当成"已有沙箱执行能力"。
 *
 * 硬约束（卡内 §01）：
 * - 模型**不得**提供宿主命令字符串、挂载、宿主路径、环境变量或容器启动参数；
 *   它只能给 `environmentIdentifier` + `executableIdentifier`（环境内已登记的标识）。
 * - 环境由**认证控制面**登记：工具链/镜像版本、可执行标识映射、输入/输出范围、
 *   资源与网络策略全部由登记方决定，模型无法选择。
 * - 模型**不得**自报"已授权"字段；授权只来自权限引擎与范围门禁。
 * - stdin 关闭、无交互、网络默认禁止（首版）。
 */
import { createHash } from "node:crypto";

import { DomainError } from "../core/errors.js";

/** 首版执行超时：默认 60s，允许 1ms–180s（仍取任务剩余预算更严值）。 */
export const PROCESS_EXECUTION_DEFAULT_TIMEOUT_MILLISECONDS = 60_000;
export const PROCESS_EXECUTION_MINIMUM_TIMEOUT_MILLISECONDS = 1;
export const PROCESS_EXECUTION_MAXIMUM_TIMEOUT_MILLISECONDS = 180_000;

/** 首版允许的 action（单一工具族，不建立多个近义工具）。 */
export const PROCESS_EXECUTION_ACTIONS = [
  "start",
  "status",
  "readOutput",
  "cancel",
] as const;
export type ProcessExecutionAction = (typeof PROCESS_EXECUTION_ACTIONS)[number];

/** 执行状态机（§03 复用同一组取值）。 */
export const PROCESS_EXECUTION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed-out",
  "unknown",
  "rejected",
] as const;
export type ProcessExecutionStatus = (typeof PROCESS_EXECUTION_STATUSES)[number];

export interface ExecutionResourcePolicy {
  readonly maximumCpuMilliseconds: number;
  readonly maximumMemoryBytes: number;
  readonly maximumProcessCount: number;
  readonly maximumDiskBytes: number;
}

/**
 * 认证控制面登记的执行环境。
 *
 * `executableIdentifiers` 把**模型可见的标识**映射到环境内部入口；
 * 模型永远看不到真实入口，也无法新增映射。
 */
export interface ExecutionEnvironmentPolicy {
  readonly environmentIdentifier: string;
  /** 确定的工具链/镜像版本（用于执行指纹与"运行中锁定版本"）。 */
  readonly toolchainVersion: string;
  readonly executableIdentifiers: Readonly<Record<string, string>>;
  /** 输入范围：项目相对目录前缀白名单。 */
  readonly allowedInputProjectRelativePrefixes: readonly string[];
  /** 输出范围：项目相对目录前缀白名单。 */
  readonly allowedOutputProjectRelativePrefixes: readonly string[];
  readonly resourcePolicy: ExecutionResourcePolicy;
  /** 首版恒 false；登记方不得通过模型输入改变它。 */
  readonly isNetworkAllowed: boolean;
}

/**
 * 登记输入：与策略同形（登记方必须给全，不能靠缺省值"看起来合规"）。
 */
export type RegisterExecutionEnvironmentInput = ExecutionEnvironmentPolicy;

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "execution-environment-invalid",
      `执行环境字段 ${fieldName} 必须是非空字符串`,
    );
  }
  return value;
}

function assertPrefixList(value: readonly string[], fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new DomainError(
      "execution-environment-invalid",
      `执行环境字段 ${fieldName} 必须是字符串数组`,
    );
  }
  return value.map((prefix, index) => {
    const normalized = assertNonEmptyString(prefix, `${fieldName}[${String(index)}]`);
    /** 前缀必须是**项目相对**的，不允许绝对路径或向上逃逸。 */
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("\\") ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.split(/[\\/]/u).includes("..")
    ) {
      throw new DomainError(
        "execution-environment-invalid",
        `执行环境字段 ${fieldName}[${String(index)}] 必须是项目相对路径且不得包含 ..：${normalized}`,
      );
    }
    return normalized;
  });
}

function assertPositiveInteger(value: unknown, fieldName: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new DomainError(
      "execution-environment-invalid",
      `执行环境字段 ${fieldName} 必须是正整数`,
    );
  }
  return value;
}

/**
 * 规范化执行环境登记（认证控制面调用）。
 *
 * 拒绝一切"看起来像隔离但没约束"的登记：缺资源额度、缺输入/输出范围、
 * 空可执行映射、允许网络，都当场失败。
 */
export function normalizeExecutionEnvironment(
  input: RegisterExecutionEnvironmentInput,
): ExecutionEnvironmentPolicy {
  const environmentIdentifier = assertNonEmptyString(
    input.environmentIdentifier,
    "environmentIdentifier",
  );
  const toolchainVersion = assertNonEmptyString(
    input.toolchainVersion,
    "toolchainVersion",
  );
  const executableEntries = Object.entries(input.executableIdentifiers ?? {});
  if (executableEntries.length === 0) {
    throw new DomainError(
      "execution-environment-invalid",
      "执行环境必须至少登记一个可执行标识（空映射等于不可用，不得登记为可用环境）",
    );
  }
  const executableIdentifiers: Record<string, string> = {};
  for (const [identifier, entry] of executableEntries) {
    executableIdentifiers[assertNonEmptyString(identifier, "executableIdentifiers 键")] =
      assertNonEmptyString(entry, `executableIdentifiers[${identifier}]`);
  }
  const allowedInputProjectRelativePrefixes = assertPrefixList(
    input.allowedInputProjectRelativePrefixes ?? [],
    "allowedInputProjectRelativePrefixes",
  );
  const allowedOutputProjectRelativePrefixes = assertPrefixList(
    input.allowedOutputProjectRelativePrefixes ?? [],
    "allowedOutputProjectRelativePrefixes",
  );
  if (allowedInputProjectRelativePrefixes.length === 0) {
    throw new DomainError(
      "execution-environment-invalid",
      "执行环境必须声明输入范围（无输入范围的执行等于全盘可读）",
    );
  }
  if (input.isNetworkAllowed) {
    throw new DomainError(
      "execution-environment-invalid",
      "首版禁止网络执行：登记网络可用环境会被拒绝（不是静默降级）",
    );
  }
  return {
    environmentIdentifier,
    toolchainVersion,
    executableIdentifiers,
    allowedInputProjectRelativePrefixes,
    allowedOutputProjectRelativePrefixes,
    resourcePolicy: {
      maximumCpuMilliseconds: assertPositiveInteger(
        input.resourcePolicy?.maximumCpuMilliseconds,
        "resourcePolicy.maximumCpuMilliseconds",
      ),
      maximumMemoryBytes: assertPositiveInteger(
        input.resourcePolicy?.maximumMemoryBytes,
        "resourcePolicy.maximumMemoryBytes",
      ),
      maximumProcessCount: assertPositiveInteger(
        input.resourcePolicy?.maximumProcessCount,
        "resourcePolicy.maximumProcessCount",
      ),
      maximumDiskBytes: assertPositiveInteger(
        input.resourcePolicy?.maximumDiskBytes,
        "resourcePolicy.maximumDiskBytes",
      ),
    },
    isNetworkAllowed: false,
  };
}

/** 环境指纹：登记内容变化即变化（执行 ID 绑定它，避免跨版本误判同一执行）。 */
export function computeExecutionEnvironmentFingerprint(
  environment: ExecutionEnvironmentPolicy,
): string {
  const canonical = JSON.stringify({
    environmentIdentifier: environment.environmentIdentifier,
    toolchainVersion: environment.toolchainVersion,
    executableIdentifiers: Object.fromEntries(
      Object.entries(environment.executableIdentifiers).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    allowedInputProjectRelativePrefixes: [...environment.allowedInputProjectRelativePrefixes],
    allowedOutputProjectRelativePrefixes: [...environment.allowedOutputProjectRelativePrefixes],
    resourcePolicy: environment.resourcePolicy,
    isNetworkAllowed: environment.isNetworkAllowed,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * 认证控制面登记表。
 *
 * 只有本地控制面可以登记；模型没有登记工具，也没有"临时环境"入口。
 */
export class ExecutionEnvironmentRegistry {
  private readonly environmentsByIdentifier = new Map<
    string,
    { readonly policy: ExecutionEnvironmentPolicy; readonly fingerprint: string }
  >();

  register(input: RegisterExecutionEnvironmentInput): {
    readonly policy: ExecutionEnvironmentPolicy;
    readonly fingerprint: string;
  } {
    const policy = normalizeExecutionEnvironment(input);
    if (this.environmentsByIdentifier.has(policy.environmentIdentifier)) {
      throw new DomainError(
        "execution-environment-invalid",
        `执行环境已登记，不得静默覆盖：${policy.environmentIdentifier}`,
      );
    }
    const entry = {
      policy,
      fingerprint: computeExecutionEnvironmentFingerprint(policy),
    };
    this.environmentsByIdentifier.set(policy.environmentIdentifier, entry);
    return entry;
  }

  get(environmentIdentifier: string): {
    readonly policy: ExecutionEnvironmentPolicy;
    readonly fingerprint: string;
  } | null {
    return this.environmentsByIdentifier.get(environmentIdentifier) ?? null;
  }

  list(): Array<{ readonly policy: ExecutionEnvironmentPolicy; readonly fingerprint: string }> {
    return [...this.environmentsByIdentifier.values()];
  }

  has(environmentIdentifier: string): boolean {
    return this.environmentsByIdentifier.has(environmentIdentifier);
  }
}

/** 模型可提交的 start 参数（**只**这些字段；多一个都拒绝）。 */
export interface ProcessExecutionStartRequest {
  readonly environmentIdentifier: string;
  readonly executableIdentifier: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMilliseconds?: number;
  readonly idempotencyKey?: string;
}

const START_ALLOWED_PARAMETERS: ReadonlySet<string> = new Set([
  "action",
  "environmentIdentifier",
  "executableIdentifier",
  "arguments",
  "workingDirectory",
  "timeoutMilliseconds",
  "idempotencyKey",
]);

const STATUS_ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(["action", "executionId"]);
const READ_OUTPUT_ALLOWED_PARAMETERS: ReadonlySet<string> = new Set([
  "action",
  "executionId",
  "stdoutCursorBytes",
  "stderrCursorBytes",
  "maximumBytes",
]);
const CANCEL_ALLOWED_PARAMETERS: ReadonlySet<string> = new Set(["action", "executionId"]);

function assertOnlyAllowedParameters(
  parsed: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  action: ProcessExecutionAction,
): void {
  const unknownParameters = Object.keys(parsed).filter(
    (parameterName) => !allowed.has(parameterName),
  );
  if (unknownParameters.length > 0) {
    throw new DomainError(
      "execution-request-invalid",
      `processExecution 的 ${action} 不接受参数：${unknownParameters.join("、")}`,
    );
  }
}

function assertProjectRelativeDirectory(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "execution-request-invalid",
      "workingDirectory 必须是非空的项目相对目录",
    );
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:/.test(value) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    throw new DomainError(
      "execution-request-invalid",
      `workingDirectory 必须是项目相对目录且不得包含 ..：${value}`,
    );
  }
  return value;
}

/** 把模型参数规范化为受控 start 请求；任何越界字段当场拒绝。 */
export function parseProcessExecutionStartRequest(
  parsed: Record<string, unknown>,
): ProcessExecutionStartRequest {
  assertOnlyAllowedParameters(parsed, START_ALLOWED_PARAMETERS, "start");
  const environmentIdentifier = assertNonEmptyString(
    parsed["environmentIdentifier"],
    "environmentIdentifier",
  );
  const executableIdentifier = assertNonEmptyString(
    parsed["executableIdentifier"],
    "executableIdentifier",
  );
  const rawArguments = parsed["arguments"];
  if (
    !Array.isArray(rawArguments) ||
    rawArguments.some((argument) => typeof argument !== "string")
  ) {
    throw new DomainError(
      "execution-request-invalid",
      "arguments 必须是字符串数组（不接受宿主命令字符串或参数对象）",
    );
  }
  const rawTimeout = parsed["timeoutMilliseconds"];
  let timeoutMilliseconds = PROCESS_EXECUTION_DEFAULT_TIMEOUT_MILLISECONDS;
  if (rawTimeout !== undefined) {
    if (
      typeof rawTimeout !== "number" ||
      !Number.isFinite(rawTimeout) ||
      rawTimeout < PROCESS_EXECUTION_MINIMUM_TIMEOUT_MILLISECONDS ||
      rawTimeout > PROCESS_EXECUTION_MAXIMUM_TIMEOUT_MILLISECONDS
    ) {
      throw new DomainError(
        "execution-request-invalid",
        `timeoutMilliseconds 必须在 ${String(PROCESS_EXECUTION_MINIMUM_TIMEOUT_MILLISECONDS)}–${String(PROCESS_EXECUTION_MAXIMUM_TIMEOUT_MILLISECONDS)} 之间`,
      );
    }
    timeoutMilliseconds = Math.floor(rawTimeout);
  }
  const rawIdempotencyKey = parsed["idempotencyKey"];
  let idempotencyKey: string | undefined;
  if (rawIdempotencyKey !== undefined) {
    idempotencyKey = assertNonEmptyString(rawIdempotencyKey, "idempotencyKey");
    if (idempotencyKey.length > 200) {
      throw new DomainError(
        "execution-request-invalid",
        "idempotencyKey 长度不得超过 200",
      );
    }
  }
  return {
    environmentIdentifier,
    executableIdentifier,
    arguments: rawArguments as string[],
    workingDirectory: assertProjectRelativeDirectory(parsed["workingDirectory"]),
    timeoutMilliseconds,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

/** 校验 status / readOutput / cancel 的参数形状。 */
export function parseProcessExecutionQueryRequest(
  action: Exclude<ProcessExecutionAction, "start">,
  parsed: Record<string, unknown>,
): { readonly executionId: string } {
  const allowed =
    action === "status"
      ? STATUS_ALLOWED_PARAMETERS
      : action === "cancel"
        ? CANCEL_ALLOWED_PARAMETERS
        : READ_OUTPUT_ALLOWED_PARAMETERS;
  assertOnlyAllowedParameters(parsed, allowed, action);
  return {
    executionId: assertNonEmptyString(parsed["executionId"], "executionId"),
  };
}

/** 执行归属：用于"只能访问本主体及明确授权的上级可管理执行"。 */
export interface ProcessExecutionOwnership {
  readonly projectIdentifier: string;
  readonly agentInstanceIdentifier: string;
  readonly missionIdentifier: string | null;
  readonly taskIdentifier: string | null;
  readonly attemptNumber: number;
  readonly authorizationRevision: number;
}

export interface ProcessExecutionIdentity extends ProcessExecutionOwnership {
  readonly executionId: string;
  readonly environmentIdentifier: string;
  readonly environmentFingerprint: string;
  readonly requestFingerprint: string;
}

/**
 * 生成执行 ID 与请求指纹。
 *
 * 要求（§01）：ID 由本地生成并绑定
 * project/agentInstanceId/mission/task/attempt/授权 revision/环境指纹。
 * 指纹用于幂等判定：同键同参返回原执行，异参拒绝。
 */
export function buildProcessExecutionIdentity(input: {
  readonly ownership: ProcessExecutionOwnership;
  readonly request: ProcessExecutionStartRequest;
  readonly environmentFingerprint: string;
  /** 生成器可注入（测试确定性）；缺省 UUID。 */
  readonly generateExecutionId?: () => string;
}): ProcessExecutionIdentity {
  const { ownership, request, environmentFingerprint } = input;
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        environmentIdentifier: request.environmentIdentifier,
        environmentFingerprint,
        executableIdentifier: request.executableIdentifier,
        arguments: request.arguments,
        workingDirectory: request.workingDirectory,
        timeoutMilliseconds: request.timeoutMilliseconds ?? null,
      }),
    )
    .digest("hex")}`;
  const executionId =
    input.generateExecutionId?.() ??
    `exec-${createHash("sha256")
      .update(
        JSON.stringify({
          projectIdentifier: ownership.projectIdentifier,
          agentInstanceIdentifier: ownership.agentInstanceIdentifier,
          missionIdentifier: ownership.missionIdentifier,
          taskIdentifier: ownership.taskIdentifier,
          attemptNumber: ownership.attemptNumber,
          authorizationRevision: ownership.authorizationRevision,
          environmentFingerprint,
          requestFingerprint,
          nonce: Date.now(),
        }),
      )
      .digest("hex")
      .slice(0, 32)}`;
  return {
    executionId,
    environmentIdentifier: request.environmentIdentifier,
    environmentFingerprint,
    requestFingerprint,
    ...ownership,
  };
}
