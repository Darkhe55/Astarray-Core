/**
 * 子进程终止原因分类（2026-11-13）。
 *
 * 背景：supervisor 过去把所有终止都记成同一句 `反馈进程故障`，
 * 于是"心跳失联自我退出"与"真实崩溃"从日志上无法区分 ——
 * 这曾直接把诊断引向错误结论（误以为操作系统在杀子进程）。
 *
 * 本模块只做**分类**（纯函数，不读进程状态）：输入退出码/信号/（将来的）自报原因，
 * 输出一个稳定类别，供日志与计数使用。真正接线（子进程通过 IPC 自报原因）留作后续，
 * 届时只需把 `reportedReason` 填进来，分类规则不变。
 */
export type ChildTerminationCategory =
  /** 子进程自报：连续错过主进程心跳，判定失联后退出。 */
  | "heartbeat-lost"
  /** 子进程自报：父进程 IPC 断开后退出。 */
  | "parent-disconnected"
  /** 子进程自报：收到 shutdown 后正常退出（不属于故障）。 */
  | "shutdown-completed"
  /** 被信号杀死（如 SIGKILL/SIGTERM），退出码通常为 null。 */
  | "killed-by-signal"
  /** 以非零退出码自行退出，但未自报原因。 */
  | "crashed"
  /** 以 0 退出，但父侧并未发起 shutdown。 */
  | "clean-exit-unexpected"
  /** 没有可用信息（既无退出码也无信号）。 */
  | "unknown";

export type ChildSelfTerminationReason =
  | "heartbeat-lost"
  | "parent-disconnected"
  | "shutdown-completed";

export interface ChildTerminationInput {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  /** 子进程在退出前通过 IPC 自报的原因（未接线的实现传 null）。 */
  readonly reportedReason: ChildSelfTerminationReason | null;
}

export function classifyChildTermination(
  input: ChildTerminationInput,
): ChildTerminationCategory {
  /** 自报原因最可信：它由子进程自己给出，优先于退出码推断。 */
  if (input.reportedReason !== null) {
    return input.reportedReason;
  }
  if (input.exitSignal !== null && input.exitSignal !== "") {
    return "killed-by-signal";
  }
  if (input.exitCode === null) {
    return "unknown";
  }
  return input.exitCode === 0 ? "clean-exit-unexpected" : "crashed";
}

/** 该类别是否属于"需要重启"的故障（shutdown-completed 不算故障）。 */
export function isFailureTerminationCategory(
  category: ChildTerminationCategory,
): boolean {
  return category !== "shutdown-completed";
}
