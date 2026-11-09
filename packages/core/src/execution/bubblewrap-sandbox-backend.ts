/**
 * EXEC-01-02：**Linux 隔离后端**（bubblewrap）。
 *
 * 依据 WSL 实测（`docs/reports/EXEC01_02_B1_REVISED_2026-11-09.md`）：
 * `--unshare-all` 后只剩 loopback、DNS 解析失败；未 bind 的宿主目录不可见；
 * bind 的工作目录可读；内存上限可挡住超额分配。
 *
 * 纪律：探测不通过 ⇒ `isAvailable=false`，`start` 拒绝（**不降级到宿主执行**）。
 */
import { spawn } from "node:child_process";

import { DomainError } from "../core/errors.js";
import type {
  SandboxCapabilityProfile,
  SandboxExecutionBackend,
  SandboxExecutionSnapshot,
  SandboxOutputStreamChunk,
  SandboxStartOutcome,
} from "./process-execution-controller.js";
import type { SandboxHelperProcess } from "./sandbox-helper-backend.js";

export interface BubblewrapBackendOptions {
  /** `bwrap` 可执行文件（缺省 `bwrap`，走 PATH）。 */
  readonly bubblewrapExecutablePath?: string;
  /** 只读 bind 的宿主目录（缺省 `/usr`、`/bin`、`/lib`、`/lib64`）。 */
  readonly readOnlyBindPaths?: readonly string[];
  /** 依赖注入：替换进程启动（测试用）。 */
  readonly spawnProcess?: (input: {
    readonly command: string;
    readonly arguments: readonly string[];
  }) => SandboxHelperProcess;
  /** 探测缓存（毫秒），缺省 60 秒。 */
  readonly probeCacheMilliseconds?: number;
}

const DEFAULT_READ_ONLY_BINDS = ["/usr", "/bin", "/lib", "/lib64"] as const;
const DEFAULT_PROBE_CACHE_MILLISECONDS = 60_000;

/**
 * 构造 bwrap 参数（**纯函数**，可离线验证）。
 *
 * 顺序要点：
 * 1. `--unshare-all` 断开网络/pid/ipc/uts 等命名空间（实测只剩 loopback）；
 * 2. `--die-with-parent` 防止父进程消失后留下孤儿；
 * 3. 只 bind **必需**的运行时目录与工作目录 —— 未 bind 的宿主目录在沙箱内不可见；
 * 4. `--chdir` 指定工作目录（不 bind 则不可进入）。
 */
export function buildBubblewrapArguments(input: {
  readonly workingDirectory: string;
  readonly executableEntryPoint: string;
  readonly arguments: readonly string[];
  readonly readOnlyBindPaths?: readonly string[];
  /** 资源上限（缺省不施加）。 */
  readonly resourceLimits?: {
    readonly maximumMemoryBytes: number;
    readonly maximumProcessCount: number;
  };
}): string[] {
  const readOnlyBindPaths = input.readOnlyBindPaths ?? DEFAULT_READ_ONLY_BINDS;
  const bwrapArguments: string[] = ["--unshare-all", "--die-with-parent"];
  for (const bindPath of readOnlyBindPaths) {
    bwrapArguments.push("--ro-bind", bindPath, bindPath);
  }
  bwrapArguments.push(
    "--ro-bind",
    input.workingDirectory,
    input.workingDirectory,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    input.workingDirectory,
    "--",
    input.executableEntryPoint,
    ...input.arguments,
  );
  return bwrapArguments;
}

/**
 * 把资源上限包成 `prlimit` 前缀（**纯函数**）。
 *
 * 为什么用 `prlimit` 而不是 bwrap 的 `--rlimit-*`：WSL 实测该 bwrap 构建
 * **没有** `--rlimit-*` 选项（`Unknown option --rlimit-as`），而 `prlimit`
 * 是 util-linux 的标准组件，语义等价（对**新进程**施加 `RLIMIT_AS` / `RLIMIT_NPROC`）。
 */
export function buildResourceLimitPrefix(input: {
  readonly maximumMemoryBytes: number;
  readonly maximumProcessCount: number;
}): string[] {
  return [
    "prlimit",
    "--as=" + String(Math.max(1, Math.floor(input.maximumMemoryBytes))),
    "--nproc=" + String(Math.max(1, Math.floor(input.maximumProcessCount))),
    "--",
  ];
}

interface BubblewrapExecutionEntry {
  readonly process: SandboxHelperProcess;
  readonly stdoutChunks: string[];
  readonly stderrChunks: string[];
  status: SandboxExecutionSnapshot;
}

export class BubblewrapSandboxBackend implements SandboxExecutionBackend {
  private readonly options: BubblewrapBackendOptions;
  private readonly executions = new Map<string, BubblewrapExecutionEntry>();
  private cachedCapability: SandboxCapabilityProfile | null = null;
  private cachedCapabilityAtMilliseconds = 0;
  private executionSequence = 0;

  constructor(options: BubblewrapBackendOptions = {}) {
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
     * 探测用**最小可用命令**：能起一个 `true` 就说明命名空间可用。
     * 只看 `--version` 不够 —— 版本能打印但用户命名空间被禁用时，
     * 真正的沙箱命令仍会失败。
     */
    let probeOutput = "";
    let isProbeOk = false;
    try {
      const probeProcess = this.spawnProcess([
        "--unshare-all",
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "/bin/true",
      ]);
      for await (const chunk of probeProcess.standardOutput) {
        probeOutput += chunk;
      }
      for await (const chunk of probeProcess.standardError) {
        probeOutput += chunk;
      }
      const exitCode = await probeProcess.exited;
      isProbeOk = exitCode === 0;
    } catch (error) {
      probeOutput += (error as Error).message;
    }
    const capability: SandboxCapabilityProfile = isProbeOk
      ? {
          isAvailable: true,
          backendIdentifier: "bubblewrap",
          isolationPrimitiveDescription:
            "bubblewrap（--unshare-all + 只读 bind + /dev + /proc）",
          reasonUnavailable: null,
        }
      : {
          isAvailable: false,
          backendIdentifier: "bubblewrap",
          isolationPrimitiveDescription:
            "bubblewrap（--unshare-all + 只读 bind + /dev + /proc）",
          reasonUnavailable:
            "bwrap 探测失败：" + (probeOutput.trim() === "" ? "无输出且未成功退出" : probeOutput.trim()),
        };
    this.cachedCapability = capability;
    this.cachedCapabilityAtMilliseconds = nowMilliseconds;
    return capability;
  }

  async start(input: {
    readonly identity: { readonly executionId: string };
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
    const capability = await this.probeCapability();
    if (!capability.isAvailable) {
      throw new DomainError(
        "execution-backend-unsupported",
        "bubblewrap 不可用：" + String(capability.reasonUnavailable ?? "未知原因"),
      );
    }
    this.executionSequence += 1;
    const backendExecutionHandle =
      "bwrap-" + input.identity.executionId + "-" + String(this.executionSequence);
    /**
     * 命令形态：`prlimit --as=… --nproc=… -- bwrap …`。
     *
     * 上限来自环境登记表（经控制器传入），后端不自行决定"给多少"。
     */
    const process = this.spawnProcess([
      ...buildResourceLimitPrefix(input.resourceLimits),
      ...buildBubblewrapArguments({
        workingDirectory: input.workingDirectory,
        executableEntryPoint: input.executableEntryPoint,
        arguments: input.arguments,
        ...(this.options.readOnlyBindPaths === undefined
          ? {}
          : { readOnlyBindPaths: this.options.readOnlyBindPaths }),
      }),
    ]);
    const entry: BubblewrapExecutionEntry = {
      process,
      stdoutChunks: [],
      stderrChunks: [],
      status: { status: "running", exitCode: null, failureReason: null },
    };
    this.executions.set(backendExecutionHandle, entry);
    void this.collect(entry, "stdout");
    void this.collect(entry, "stderr");
    /**
     * 超时必须在**执行层**真的停住，而不是只让调用方看到"已经超时"。
     *
     * 为什么不用 `timeout(1)` 包一层：那会给产品增加一个外部命令依赖；
     * 这里用进程内定时器，到点直接终止 bwrap（`--die-with-parent` 保证子进程一起收掉）。
     */
    const timeoutTimer = setTimeout(() => {
      if (entry.status.status !== "running") return;
      entry.process.terminate();
      entry.status = {
        status: "timed-out",
        exitCode: null,
        failureReason: "超过时限 " + String(input.timeoutMilliseconds) + " ms（已终止沙箱进程）",
      };
    }, Math.max(1, input.timeoutMilliseconds));
    timeoutTimer.unref?.();
    void process.exited.then((exitCode) => {
      clearTimeout(timeoutTimer);
      if (entry.status.status !== "running") return;
      entry.status =
        exitCode === 0
          ? { status: "succeeded", exitCode: 0, failureReason: null }
          : {
              status: "failed",
              exitCode: exitCode ?? null,
              failureReason: "bwrap 退出码 " + String(exitCode),
            };
    });
    return { backendExecutionHandle, status: "running" };
  }

  async readStatus(backendExecutionHandle: string): Promise<SandboxExecutionSnapshot> {
    return this.requireEntry(backendExecutionHandle).status;
  }

  async readOutputStream(input: {
    readonly backendExecutionHandle: string;
    readonly stream: "stdout" | "stderr";
    readonly fromCursorBytes: number;
    readonly maximumBytes: number;
  }): Promise<SandboxOutputStreamChunk> {
    const entry = this.requireEntry(input.backendExecutionHandle);
    const chunks = input.stream === "stdout" ? entry.stdoutChunks : entry.stderrChunks;
    const buffer = Buffer.from(chunks.join(""), "utf8");
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
      entry.process.terminate();
      entry.status = { status: "cancelled", exitCode: null, failureReason: reason };
    }
    return entry.status;
  }

  private requireEntry(backendExecutionHandle: string): BubblewrapExecutionEntry {
    const entry = this.executions.get(backendExecutionHandle);
    if (entry === undefined) {
      throw new DomainError(
        "execution-not-found",
        "未知的后端执行句柄：" + backendExecutionHandle,
      );
    }
    return entry;
  }

  private spawnProcess(bwrapArguments: readonly string[]): SandboxHelperProcess {
    const spawnProcess = this.options.spawnProcess;
    const command = this.options.bubblewrapExecutablePath ?? "bwrap";
    if (spawnProcess !== undefined) {
      return spawnProcess({ command, arguments: bwrapArguments });
    }
    const child = spawn(command, [...bwrapArguments], {
      stdio: ["ignore", "pipe", "pipe"],
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
        child.kill("SIGKILL");
      },
    };
  }

  private async collect(
    entry: BubblewrapExecutionEntry,
    stream: "stdout" | "stderr",
  ): Promise<void> {
    const source = stream === "stdout" ? entry.process.standardOutput : entry.process.standardError;
    const sink = stream === "stdout" ? entry.stdoutChunks : entry.stderrChunks;
    try {
      for await (const chunk of source) {
        sink.push(chunk);
      }
    } catch {
      /** 输出读取失败不改写状态：状态由退出码决定。 */
    }
  }
}

async function* toChunks(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
}
