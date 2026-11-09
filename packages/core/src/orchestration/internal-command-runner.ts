/**
 * EXEC-01-04（2026-11-09）：**内部可信命令的异步执行**。
 *
 * 为什么需要它：`spawnSync` 会阻塞事件循环，慢命令期间用户的
 * 状态查询、取消请求、对话都被卡住 —— 卡内 §04 明确要求改为可取消的异步实现。
 *
 * 边界（不得被误解为模型能力）：
 * - 命令来源是**会话/项目配置**（可信控制面），不是模型输入；
 * - 这里**不是沙箱**：只是"异步 + 有超时 + 不继承宿主凭据 + 有界输出"，
 *   隔离等级在返回值里如实标注，不得用环境白名单冒充沙箱；
 * - 输出有界保留（尾部），用于诊断；不写进模型历史。
 */
import { spawn } from "node:child_process";

import { buildRestrictedSubprocessEnvironment } from "../infra/subprocess-environment-allowlist.js";

/** 保留的诊断输出上限（尾部字符数）；避免把整份构建日志读进内存。 */
export const INTERNAL_COMMAND_DIAGNOSTIC_TAIL_CHARACTERS = 4_000;

export interface InternalCommandOutcome {
  /** 进程是否成功（退出码 0 且未超时/未取消）。 */
  readonly isSuccessful: boolean;
  /** 真实退出码；超时/取消/启动失败时为 null。 */
  readonly exitCode: number | null;
  readonly isTimedOut: boolean;
  readonly isCancelled: boolean;
  /** 启动失败或信号终止的原因（不含完整命令正文）。 */
  readonly failureReason: string | null;
  /** 尾部诊断输出（已截断，仅供日志/证据，不进入模型历史）。 */
  readonly stdoutTail: string;
  readonly stderrTail: string;
  /** 隔离等级说明：如实标注，避免"环境白名单 = 沙箱"的误解。 */
  readonly isolationLevelDescription: string;
}

const ISOLATION_LEVEL_DESCRIPTION =
  "非沙箱：仅异步 + 超时 + 受限环境变量 + 有界输出；无文件系统/网络隔离";

function takeTail(text: string, maximumCharacters: number): string {
  if (text.length <= maximumCharacters) return text;
  return text.slice(text.length - maximumCharacters);
}

/**
 * 以 shell 执行一条**配置命令**（异步、可取消、有超时）。
 *
 * `cancellationSignal` 触发时向整个进程树发终止信号；超时同样终止。
 * 两种情况都如实标记，不把"被杀掉"说成"失败但原因未知"。
 */
export async function runInternalCommandAsync(input: {
  readonly command: string;
  readonly workingDirectoryPath: string;
  readonly timeoutMilliseconds: number;
  readonly cancellationSignal?: AbortSignal | null;
}): Promise<InternalCommandOutcome> {
  if (input.cancellationSignal?.aborted === true) {
    return {
      isSuccessful: false,
      exitCode: null,
      isTimedOut: false,
      isCancelled: true,
      failureReason: "执行前已被取消",
      stdoutTail: "",
      stderrTail: "",
      isolationLevelDescription: ISOLATION_LEVEL_DESCRIPTION,
    };
  }
  return new Promise<InternalCommandOutcome>((resolve) => {
    let stdoutText = "";
    let stderrText = "";
    let isTimedOut = false;
    let isCancelled = false;
    let failureReason: string | null = null;
    let isSettled = false;

    const child = spawn(input.command, {
      cwd: input.workingDirectoryPath,
      shell: true,
      windowsHide: true,
      /** SEC-02-07：配置命令不继承宿主凭据环境（只带运行必需变量）。 */
      env: buildRestrictedSubprocessEnvironment({ hostEnvironment: process.env }).environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const settle = (outcome: Omit<InternalCommandOutcome, "stdoutTail" | "stderrTail" | "isolationLevelDescription">): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutHandle);
      input.cancellationSignal?.removeEventListener("abort", onAbort);
      resolve({
        ...outcome,
        stdoutTail: takeTail(stdoutText, INTERNAL_COMMAND_DIAGNOSTIC_TAIL_CHARACTERS),
        stderrTail: takeTail(stderrText, INTERNAL_COMMAND_DIAGNOSTIC_TAIL_CHARACTERS),
        isolationLevelDescription: ISOLATION_LEVEL_DESCRIPTION,
      });
    };

    const terminate = (): void => {
      /** shell 启动的子进程不会自动随父进程退出：按进程树杀掉（平台不同，失败不致命）。 */
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid ?? 0), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => undefined);
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经退出：忽略。
      }
    };

    const timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      terminate();
    }, Math.max(1, input.timeoutMilliseconds));

    const onAbort = (): void => {
      isCancelled = true;
      terminate();
    };
    input.cancellationSignal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      /** 只保留尾部，避免慢命令把整份日志堆进内存。 */
      stdoutText = takeTail(stdoutText + chunk.toString("utf8"), INTERNAL_COMMAND_DIAGNOSTIC_TAIL_CHARACTERS);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText = takeTail(stderrText + chunk.toString("utf8"), INTERNAL_COMMAND_DIAGNOSTIC_TAIL_CHARACTERS);
    });
    child.on("error", (error: Error) => {
      failureReason = `命令启动失败：${error.message}`;
      settle({
        isSuccessful: false,
        exitCode: null,
        isTimedOut: false,
        isCancelled: false,
        failureReason,
      });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (isTimedOut) {
        settle({
          isSuccessful: false,
          exitCode: null,
          isTimedOut: true,
          isCancelled: false,
          failureReason: `超时（${String(input.timeoutMilliseconds)}ms）已终止`,
        });
        return;
      }
      if (isCancelled) {
        settle({
          isSuccessful: false,
          exitCode: null,
          isTimedOut: false,
          isCancelled: true,
          failureReason: "已被取消",
        });
        return;
      }
      settle({
        isSuccessful: code === 0,
        exitCode: code,
        isTimedOut: false,
        isCancelled: false,
        failureReason:
          code === null
            ? `进程被信号终止：${String(signal ?? "unknown")}`
            : code === 0
              ? null
              : `退出码 ${String(code)}`,
      });
    });
  });
}
