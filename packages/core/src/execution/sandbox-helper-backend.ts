/**
 * EXEC-01-02：把**原生沙箱辅助程序**接成受控执行后端。
 *
 * 为什么单独一层：`ProcessExecutionController` 只认 `SandboxExecutionBackend` 端口，
 * 真正"怎么隔离"必须由平台相关实现回答。这一层负责**协议**（启动 / 查询 / 读输出 / 取消）
 * 与**如实探测**，隔离强度本身由辅助程序决定。
 *
 * 诚实边界（2026-11-09 实测）：
 * - Windows 辅助程序的 Job Object 半区已真实验证（内存/进程数/超时）；
 * - AppContainer 档案创建在**非管理员**进程返回 `E_ACCESSDENIED`，
 *   因此 `probeCapability()` 必须报**不可用**，`start()` 一律拒绝 —— 不静默降级到宿主执行。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type {
  SandboxCapabilityProfile,
  SandboxExecutionBackend,
  SandboxExecutionSnapshot,
  SandboxOutputStreamChunk,
  SandboxStartOutcome,
} from "./process-execution-controller.js";

export interface SandboxHelperBackendOptions {
  /** 辅助程序可执行文件（绝对路径或 PATH 中的名字）。 */
  readonly helperExecutablePath: string;
  /** 附加参数（例如 `--profile`）。 */
  readonly helperArguments?: readonly string[];
  /** 每个执行实例的隔离档案名（缺省由后端按执行标识生成）。 */
  readonly profileNamePrefix?: string;
  /** 探测结果缓存时长（毫秒）；缺省 60 秒。 */
  readonly probeCacheMilliseconds?: number;
  /** 依赖注入：替换进程启动（测试用；生产用默认 `spawn`）。 */
  readonly spawnHelper?: (input: {
    readonly command: string;
    readonly arguments: readonly string[];
  }) => SandboxHelperProcess;
}

/** 辅助程序进程的最小接口（便于测试替换，不引入假隔离语义）。 */
export interface SandboxHelperProcess {
  readonly processIdentifier: number;
  readonly standardOutput: AsyncIterable<string>;
  readonly standardError: AsyncIterable<string>;
  readonly exited: Promise<number | null>;
  terminate(): void;
}

interface ExecutionEntry {
  readonly helperProcess: SandboxHelperProcess;
  readonly stdoutChunks: string[];
  readonly stderrChunks: string[];
  status: SandboxExecutionSnapshot;
}

const DEFAULT_PROBE_CACHE_MILLISECONDS = 60_000;

/**
 * 由**项目标识**派生稳定档案名（**纯函数**）。
 *
 * 名字要满足 AppContainer 的字符集要求（`[-_. A-Za-z0-9]+`）且不超过 64 字符，
 * 因此用哈希前缀而不是项目名本身（项目名可能含中文/空格）。
 */
export function buildProjectProfileName(prefix: string, projectIdentifier: string): string {
  const digest = createHash("sha256").update(projectIdentifier, "utf8").digest("hex").slice(0, 12);
  return (prefix + "-" + digest).slice(0, 64);
}

export class SandboxHelperBackend implements SandboxExecutionBackend {
  private readonly options: SandboxHelperBackendOptions;
  private readonly executions = new Map<string, ExecutionEntry>();
  private cachedCapability: SandboxCapabilityProfile | null = null;
  private cachedCapabilityAtMilliseconds = 0;
  private executionSequence = 0;

  constructor(options: SandboxHelperBackendOptions) {
    this.options = options;
  }

  async probeCapability(): Promise<SandboxCapabilityProfile> {
    const nowMilliseconds = Date.now();
    const cacheMilliseconds =
      this.options.probeCacheMilliseconds ?? DEFAULT_PROBE_CACHE_MILLISECONDS;
    if (
      this.cachedCapability !== null &&
      nowMilliseconds - this.cachedCapabilityAtMilliseconds < cacheMilliseconds
    ) {
      return this.cachedCapability;
    }
    /**
     * 探测本身也可能失败（文件不是可执行、权限不足…）。
     *
     * 这类失败必须归为**不可用**，而不是把底层 `spawn` 错误原样抛给调用方 ——
     * 否则上层拿到的是 "spawn EFTYPE" 这种既不解释原因、又看不出"该拒绝执行"的文本。
     */
    let probeOutput = "";
    try {
      const probeProcess = this.startHelper(["probe"]);
      for await (const chunk of probeProcess.standardOutput) {
        probeOutput += chunk;
      }
      await probeProcess.exited;
    } catch (error) {
      const capability: SandboxCapabilityProfile = {
        isAvailable: false,
        backendIdentifier: "sandbox-helper",
        isolationPrimitiveDescription: "AppContainer + Job Object（辅助程序）",
        reasonUnavailable: "辅助程序无法启动：" + (error as Error).message,
      };
      this.cachedCapability = capability;
      this.cachedCapabilityAtMilliseconds = nowMilliseconds;
      return capability;
    }
    const capability = interpretProbeOutput(probeOutput);
    this.cachedCapability = capability;
    this.cachedCapabilityAtMilliseconds = nowMilliseconds;
    return capability;
  }

  async start(input: {
    readonly identity: {
      readonly executionId: string;
      /** 项目归属：用于派生**每项目**档案名（避免跨项目共用一个 SID）。 */
      readonly projectIdentifier: string;
    };
    readonly executableEntryPoint: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly timeoutMilliseconds: number;
    readonly streamStorageLimitBytes: number;
    readonly resourceLimits: {
      readonly maximumMemoryBytes: number;
      readonly maximumProcessCount: number;
    };
  }): Promise<SandboxStartOutcome> {
    /**
     * 能力不足 ⇒ **拒绝启动**（`execution-backend-unsupported`）。
     *
     * 这一条是本层的核心纪律：没有可用隔离就不得执行，而不是"先跑起来再说"。
     */
    const capability = await this.probeCapability();
    if (!capability.isAvailable) {
      throw new DomainError(
        "execution-backend-unsupported",
        "沙箱辅助程序不可用：" + String(capability.reasonUnavailable ?? "未知原因"),
      );
    }
    this.executionSequence += 1;
    const backendExecutionHandle =
      "helper-" + input.identity.executionId + "-" + String(this.executionSequence);
    /**
     * 档案名**按项目**派生（稳定），不是按执行序号。
     *
     * 为什么必须这样（用户裁决 2026-11-09）：
     *  - 档案是 **per-user per-app**，运行期建档案需要提权 ⇒ 不能每次执行换一个名字；
     *  - 若两个项目共用同一个 SID，又各自把项目目录授权给该 SID，
     *    则项目 A 可以读项目 B 的目录 —— 这正是要禁止的**跨项目互读**。
     * 因此每个项目一个稳定档案名 ⇒ 每个项目一个独立 SID。
     */
    const profileName = buildProjectProfileName(
      this.options.profileNamePrefix ?? "astarray-exec",
      input.identity.projectIdentifier,
    );
    /**
     * 把**环境登记表**的上限传给辅助程序（它用 Job Object 施加）。
     *
     * 此前这两项从未传过 ⇒ 登记的限额对真实执行不生效（辅助程序有参数，但没人给）。
     */
    const maximumMemoryMegabytes = Math.max(
      1,
      Math.floor(input.resourceLimits.maximumMemoryBytes / (1024 * 1024)),
    );
    const helperProcess = this.startHelper([
      "run",
      "--profile",
      profileName,
      "--timeout-ms",
      String(input.timeoutMilliseconds),
      "--max-memory-mb",
      String(maximumMemoryMegabytes),
      "--max-processes",
      String(Math.max(1, Math.floor(input.resourceLimits.maximumProcessCount))),
      "--",
      input.executableEntryPoint,
      ...input.arguments,
    ]);
    const entry: ExecutionEntry = {
      helperProcess,
      stdoutChunks: [],
      stderrChunks: [],
      status: { status: "running", exitCode: null, failureReason: null },
    };
    this.executions.set(backendExecutionHandle, entry);
    /** 后台收集输出与退出码：不阻塞 `start`（调用方随后轮询）。 */
    void this.collectOutput(entry, "stdout");
    void this.collectOutput(entry, "stderr");
    void helperProcess.exited.then((exitCode) => {
      if (entry.status.status !== "running") return;
      entry.status =
        exitCode === 0
          ? { status: "succeeded", exitCode: 0, failureReason: null }
          : exitCode === 124
            ? { status: "timed-out", exitCode: 124, failureReason: "超过时限（辅助程序已终止进程树）" }
            : {
                status: "failed",
                exitCode: exitCode ?? null,
                failureReason: "辅助程序退出码 " + String(exitCode),
              };
    });
    return { backendExecutionHandle, status: "running" };
  }

  async readStatus(backendExecutionHandle: string): Promise<SandboxExecutionSnapshot> {
    const entry = this.requireEntry(backendExecutionHandle);
    return entry.status;
  }

  async readOutputStream(input: {
    readonly backendExecutionHandle: string;
    readonly stream: "stdout" | "stderr";
    readonly fromCursorBytes: number;
    readonly maximumBytes: number;
  }): Promise<SandboxOutputStreamChunk> {
    const entry = this.requireEntry(input.backendExecutionHandle);
    const chunks = input.stream === "stdout" ? entry.stdoutChunks : entry.stderrChunks;
    const text = chunks.join("");
    const buffer = Buffer.from(text, "utf8");
    const fromCursorBytes = Math.min(Math.max(0, input.fromCursorBytes), buffer.length);
    const endCursorBytes = Math.min(
      buffer.length,
      fromCursorBytes + Math.max(1, input.maximumBytes),
    );
    return {
      text: buffer.subarray(fromCursorBytes, endCursorBytes).toString("utf8"),
      nextCursorBytes: endCursorBytes,
      isTruncated: endCursorBytes < buffer.length,
    };
  }

  async cancel(backendExecutionHandle: string, reason: string): Promise<SandboxExecutionSnapshot> {
    const entry = this.requireEntry(backendExecutionHandle);
    if (entry.status.status === "running") {
      entry.helperProcess.terminate();
      entry.status = { status: "cancelled", exitCode: null, failureReason: reason };
    }
    return entry.status;
  }

  private requireEntry(backendExecutionHandle: string): ExecutionEntry {
    const entry = this.executions.get(backendExecutionHandle);
    if (entry === undefined) {
      throw new DomainError(
        "execution-not-found",
        "未知的后端执行句柄：" + backendExecutionHandle,
      );
    }
    return entry;
  }

  private startHelper(argumentsToPass: readonly string[]): SandboxHelperProcess {
    const command = this.options.helperExecutablePath;
    const fullArguments = [...(this.options.helperArguments ?? []), ...argumentsToPass];
    const spawnHelper = this.options.spawnHelper;
    if (spawnHelper !== undefined) {
      return spawnHelper({ command, arguments: fullArguments });
    }
    return spawnNodeHelper(command, fullArguments);
  }

  private async collectOutput(entry: ExecutionEntry, stream: "stdout" | "stderr"): Promise<void> {
    const source = stream === "stdout" ? entry.helperProcess.standardOutput : entry.helperProcess.standardError;
    const sink = stream === "stdout" ? entry.stdoutChunks : entry.stderrChunks;
    try {
      for await (const chunk of source) {
        sink.push(chunk);
      }
    } catch {
      /** 输出读取失败不改写状态：状态由退出码决定（不伪造成功）。 */
    }
  }
}

/** 把辅助程序的探测输出翻译成能力画像（**只认明确的成功标记**）。 */
export function interpretProbeOutput(probeOutput: string): SandboxCapabilityProfile {
  const lines = probeOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const unavailableLine = lines.find((line) => line.startsWith("appcontainer-unavailable"));
  if (unavailableLine !== undefined) {
    return {
      isAvailable: false,
      backendIdentifier: "sandbox-helper",
      isolationPrimitiveDescription: "AppContainer + Job Object（辅助程序）",
      reasonUnavailable:
        "AppContainer 档案不可建：" + unavailableLine.replace("appcontainer-unavailable", "").trim(),
    };
  }
  const hasCreated = lines.some((line) => line.startsWith("appcontainer-created"));
  const hasDeleted = lines.some((line) => line.startsWith("appcontainer-deleted hresult=0x00000000"));
  const hasJob = lines.some((line) => line === "job-created");
  if (!hasCreated || !hasDeleted || !hasJob) {
    return {
      isAvailable: false,
      backendIdentifier: "sandbox-helper",
      isolationPrimitiveDescription: "AppContainer + Job Object（辅助程序）",
      reasonUnavailable: "探测未给出完整的成功标记（不得据此认为可用）",
    };
  }
  return {
    isAvailable: true,
    backendIdentifier: "sandbox-helper",
    isolationPrimitiveDescription: "AppContainer + Job Object（辅助程序）",
    reasonUnavailable: null,
  };
}

/** 默认实现：真实子进程（`spawn`），输出按块透传，终止走整树 kill。 */
function spawnNodeHelper(
  command: string,
  argumentsToPass: readonly string[],
): SandboxHelperProcess {
  const child = spawn(command, [...argumentsToPass], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return {
    processIdentifier: child.pid ?? -1,
    standardOutput: toChunks(child.stdout),
    standardError: toChunks(child.stderr),
    exited,
    terminate: () => {
      /** Windows 上 `kill` 只杀直接子进程，必须整树终止（辅助程序本身会收掉作业）。 */
      if (process.platform === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        return;
      }
      child.kill("SIGKILL");
    },
  };
}

async function* toChunks(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
}
