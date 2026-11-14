/**
 * CLI 执行状态事件输出（EXEC-01-04「CLI 运行路径消费同一事件」的第一步；2026-11-14）。
 *
 * 背景：`run` 命令**强制 `--json`**（人类可读模式走 TUI），因此"消费事件"的正确形态是
 * **向 stdout 追加可解析的 JSONL 行**，而不是打印彩色日志。
 *
 * 本模块只做**纯格式化**：把公开事件转成一行 JSON；不是 `execution-status` 的事件返回 null
 * （由调用方跳过，不得静默塞进无关内容）。
 *
 * 字段固定白名单：**不含后端句柄、不含原始命令、不含 stdin/环境**；
 * 失败原因再过一次脱敏（上游已脱敏，这里防回归）。
 */
import { redactSensitiveText } from "../../../core/src/orchestration/diagnostic-event-store.js";
import type { PublicAstarrayEvent } from "../../../core/src/public-sdk.js";

/** 事件行类型标识：与最终结果对象区分，消费方可按 `type` 分流。 */
export const EXECUTION_STATUS_LINE_TYPE = "execution-status" as const;

export interface ExecutionStatusJsonLine {
  readonly type: typeof EXECUTION_STATUS_LINE_TYPE;
  readonly executionId: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly failureReason: string | null;
  readonly terminationKind: string | null;
  readonly revision: number;
}

function isFiniteIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 事件 → 一行 JSON 文本（**不含换行符**；调用方负责 `\n`）。
 *
 * 非 `execution-status` 事件 ⇒ 返回 `null`。
 * 缺少 `executionId` 的事件同样返回 `null`（无法归属的状态行没有价值，且会污染输出）。
 */
export function formatExecutionStatusJsonLine(event: PublicAstarrayEvent): string | null {
  if (event.eventType !== EXECUTION_STATUS_LINE_TYPE) {
    return null;
  }
  const executionId = stringOrNull((event as { executionId?: unknown }).executionId);
  if (executionId === null || executionId.trim() === "") {
    return null;
  }
  const exitCode = (event as { exitCode?: unknown }).exitCode;
  const revision = (event as { revision?: unknown }).revision;
  const status = stringOrNull((event as { status?: unknown }).status);
  if (status === null || typeof revision !== "number" || !Number.isFinite(revision)) {
    return null;
  }
  const rawFailureReason = stringOrNull((event as { failureReason?: unknown }).failureReason);
  const line: ExecutionStatusJsonLine = {
    type: EXECUTION_STATUS_LINE_TYPE,
    executionId,
    status,
    exitCode: isFiniteIntegerOrNull(exitCode) ? exitCode : null,
    failureReason:
      rawFailureReason === null ? null : redactSensitiveText(rawFailureReason),
    terminationKind: stringOrNull((event as { terminationKind?: unknown }).terminationKind),
    revision,
  };
  return JSON.stringify(line);
}

/** 可订阅的最小接口（便于测试注入；真实实现是 facade）。 */
export interface ExecutionStatusEventSource {
  subscribe(listener: (event: PublicAstarrayEvent) => void): { unsubscribe(): void };
}

export interface ExecutionStatusSubscription {
  /** 收到并成功输出的行数（诊断/测试用；不参与业务判定）。 */
  getWrittenLineCount(): number;
  unsubscribe(): void;
}

/**
 * 订阅执行状态事件并逐行写出。
 *
 * 纪律：
 * - 只写能格式化的行（非执行状态事件一律忽略，不写空行、不抛错打断运行）；
 * - 写失败（例如 stdout 已关闭）**不得**让任务失败——记录后继续（CLI 仍要跑完任务）；
 * - 退订必须由调用方在**所有退出路径**执行（本函数不自带生命周期魔法）。
 */
export function subscribeExecutionStatusJsonLines(input: {
  readonly eventSource: ExecutionStatusEventSource;
  readonly writeLine: (lineText: string) => void;
}): ExecutionStatusSubscription {
  let writtenLineCount = 0;
  const subscription = input.eventSource.subscribe((event) => {
    const lineText = formatExecutionStatusJsonLine(event);
    if (lineText === null) {
      return;
    }
    try {
      input.writeLine(lineText);
      writtenLineCount += 1;
    } catch {
      /** 输出通道故障不得影响任务本身。 */
    }
  });
  return {
    getWrittenLineCount: () => writtenLineCount,
    unsubscribe: () => {
      subscription.unsubscribe();
    },
  };
}

/**
 * 事件输出去向（2026-11-14 用户决策 C）：**默认写 stderr**。
 *
 * 理由：`--json` 的 stdout 契约是"一个结果对象"，多行事件混进去会打断
 * `JSON.parse(stdout)` 这类既有消费者；写 stderr 则"默认可用"且不破坏契约。
 * 需要单流时显式选择 stdout。
 */
export type ExecutionEventOutputTarget = "stderr" | "stdout" | "off";

export function resolveExecutionEventOutputTarget(
  explicitChoice: boolean | undefined,
): ExecutionEventOutputTarget {
  if (explicitChoice === true) {
    return "stdout";
  }
  if (explicitChoice === false) {
    return "off";
  }
  return "stderr";
}
