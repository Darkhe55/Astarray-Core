/**
 * E3（2026-11-25）：沙箱 broker 的**请求准入**纯判定层。
 *
 * 背景：Windows 上非提权父进程无法创建 AppContainer 子进程（实测 Access Denied 5）。
 * 强档必须由安装期注册的 broker 代为创建；broker 因此成为**新的信任边界**，
 * 必须把"谁能请求什么"判定为纯函数、先写反例、再做 IPC。
 *
 * 设计纪律：
 * - **调用方身份来自 IPC 对端**（不是请求体自报）；这里要求显式传入已认证 SID；
 * - 只服务**一个**用户（安装/绑定者）：SID 不匹配一律拒绝；
 * - 只接受**登记过的环境**与**登记过的可执行文件绝对路径**；
 * - 工作目录必须在登记根之内（按路径段比较，`C:\work-evil` 不算 `C:\work` 之内）；
 * - 资源上限只能**收紧**，不能超过登记上限；
 * - 请求标识必填且去重（重放/重试不得触发第二次副作用）。
 */
import path from "node:path";

export interface SandboxBrokerEnvironmentPolicy {
  /** 该环境允许启动的可执行文件（绝对路径；调用方不得靠 PATH 解析）。 */
  readonly allowedExecutablePaths: readonly string[];
  /** 该环境允许的工作目录根（绝对路径）。 */
  readonly allowedWorkingDirectoryRoots: readonly string[];
}

export interface SandboxBrokerPolicy {
  /** 唯一被服务的调用方 SID（来自 IPC 对端身份）。 */
  readonly allowedCallerSid: string;
  readonly allowedEnvironments: Readonly<Record<string, SandboxBrokerEnvironmentPolicy>>;
  /** 登记上限：请求只能收紧，不能放宽。 */
  readonly maximumMemoryBytes: number;
  readonly maximumProcessCount: number;
  readonly maximumTimeoutMilliseconds: number;
}

export interface SandboxBrokerRequest {
  readonly requestIdentifier: string;
  readonly environmentIdentifier: string;
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly resourceLimits: {
    readonly maximumMemoryBytes: number;
    readonly maximumProcessCount: number;
  };
  readonly timeoutMilliseconds: number;
}

export type SandboxBrokerRejectionReason =
  | "invalid-request"
  | "caller-sid-mismatch"
  | "unknown-environment"
  | "executable-not-allowed"
  | "working-directory-not-allowed"
  | "resource-limit-exceeded"
  | "timeout-exceeded"
  | "duplicate-request";

export type SandboxBrokerDecision =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "rejected";
      readonly reasonCode: SandboxBrokerRejectionReason;
      readonly detail: string;
    };

function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 路径是否在根之内（按路径段；`/work-evil` 不在 `/work` 之内）。 */
export function isPathWithinRoot(
  candidatePath: string,
  rootPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const candidate = normalizeForComparison(candidatePath, platform);
  const root = normalizeForComparison(rootPath, platform).replace(/[\\/]+$/u, "");
  if (candidate === root) return true;
  const withSeparator = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(withSeparator);
}

function hasControlCharacters(value: string): boolean {
  /** 不用正则字面量里的控制字符范围（ESLint `no-control-regex`）；逐码点判断更直观。 */
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * 判定一次 broker 请求。
 *
 * @param seenRequestIdentifiers broker 维护的**已接受**请求集合（由调用方持有并更新；本函数不修改）。
 */
export function evaluateSandboxBrokerRequest(input: {
  readonly request: SandboxBrokerRequest;
  readonly authenticatedCallerSid: string | null;
  readonly policy: SandboxBrokerPolicy;
  readonly seenRequestIdentifiers?: ReadonlySet<string>;
}): SandboxBrokerDecision {
  const { request, authenticatedCallerSid, policy } = input;
  const reject = (
    reasonCode: SandboxBrokerRejectionReason,
    detail: string,
  ): SandboxBrokerDecision => ({ kind: "rejected", reasonCode, detail });

  if (authenticatedCallerSid === null || authenticatedCallerSid.trim() === "") {
    return reject("invalid-request", "缺少已认证调用方身份（不信任请求体自报）。");
  }
  if (authenticatedCallerSid !== policy.allowedCallerSid) {
    return reject("caller-sid-mismatch", "调用方 SID 与绑定用户不一致，拒绝。");
  }
  const requestIdentifier = request.requestIdentifier.trim();
  if (requestIdentifier === "") {
    return reject("invalid-request", "请求标识为空：无法去重，拒绝。");
  }
  if (input.seenRequestIdentifiers?.has(requestIdentifier) === true) {
    return reject("duplicate-request", "该请求已处理过（幂等复用，不重复执行副作用）。");
  }
  const environment = policy.allowedEnvironments[request.environmentIdentifier];
  if (environment === undefined) {
    return reject("unknown-environment", `环境未登记：${request.environmentIdentifier}`);
  }
  const executablePath = request.executablePath.trim();
  if (executablePath === "" || hasControlCharacters(executablePath)) {
    return reject("invalid-request", "可执行文件路径为空或含控制字符。");
  }
  if (!path.isAbsolute(executablePath)) {
    return reject("executable-not-allowed", "可执行文件必须是登记过的绝对路径（不接受 PATH 解析）。");
  }
  const normalizedExecutable = normalizeForComparison(executablePath, process.platform);
  const isExecutableAllowed = environment.allowedExecutablePaths.some(
    (allowedPath) => normalizeForComparison(allowedPath, process.platform) === normalizedExecutable,
  );
  if (!isExecutableAllowed) {
    return reject("executable-not-allowed", `可执行文件不在登记清单：${executablePath}`);
  }
  const workingDirectory = request.workingDirectory.trim();
  if (workingDirectory === "" || hasControlCharacters(workingDirectory)) {
    return reject("invalid-request", "工作目录为空或含控制字符。");
  }
  if (!path.isAbsolute(workingDirectory)) {
    return reject("working-directory-not-allowed", "工作目录必须是绝对路径。");
  }
  const isWorkingDirectoryAllowed = environment.allowedWorkingDirectoryRoots.some((rootPath) =>
    isPathWithinRoot(workingDirectory, rootPath),
  );
  if (!isWorkingDirectoryAllowed) {
    return reject("working-directory-not-allowed", `工作目录不在登记根之内：${workingDirectory}`);
  }
  if (
    request.arguments.some((argument) => hasControlCharacters(argument))
  ) {
    return reject("invalid-request", "参数含控制字符（不接受 NUL/换行等）。");
  }
  if (
    request.resourceLimits.maximumMemoryBytes <= 0 ||
    request.resourceLimits.maximumMemoryBytes > policy.maximumMemoryBytes
  ) {
    return reject(
      "resource-limit-exceeded",
      `内存上限超出登记上限（${String(policy.maximumMemoryBytes)} 字节）。`,
    );
  }
  if (
    request.resourceLimits.maximumProcessCount <= 0 ||
    request.resourceLimits.maximumProcessCount > policy.maximumProcessCount
  ) {
    return reject(
      "resource-limit-exceeded",
      `进程数上限超出登记上限（${String(policy.maximumProcessCount)}）。`,
    );
  }
  if (
    request.timeoutMilliseconds <= 0 ||
    request.timeoutMilliseconds > policy.maximumTimeoutMilliseconds
  ) {
    return reject(
      "timeout-exceeded",
      `超时超出登记上限（${String(policy.maximumTimeoutMilliseconds)} ms）。`,
    );
  }
  return { kind: "accepted" };
}
