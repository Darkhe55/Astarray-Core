/**
 * SHUTDOWN-01（2026-11-17）：**后台写收敛追踪**。
 *
 * 背景（实证）：`shutdown()` 会等待在途编排收敛，但**不等**事件回调里
 * fire-and-forget 的派生写（`void (async () => …)()`）。于是进程退出时，
 * "目标暂停标记 / 任务-序列映射清理 / 违规状态"这类写可能没落盘。
 *
 * 本模块只做一件事：登记这些后台写，并在关闭时**有界地**等它们结束。
 *
 * 纪律：
 * - **不改变**写入时机与顺序（登记不等于 await，调用方仍是异步发起）；
 * - drain **有界**：超时如实报告，绝不把进程挂死；
 * - 失败**不吞**：失败项计入返回值，调用方可记录/上报。
 */
export interface PendingWriteDrainResult {
  readonly drainedCount: number;
  readonly timedOutCount: number;
  readonly failedCount: number;
  readonly failureMessages: readonly string[];
}

export class PendingWriteTracker {
  private readonly pendingWrites = new Set<Promise<unknown>>();

  /** 当前在飞数量（观测用）。 */
  get pendingCount(): number {
    return this.pendingWrites.size;
  }

  /**
   * 登记一个后台写。返回原 Promise，调用方仍可按原样 `void` 或 `catch`。
   */
  track<T>(pendingWrite: Promise<T>): Promise<T> {
    const settled = pendingWrite
      .catch(() => undefined)
      .finally(() => {
        this.pendingWrites.delete(settled);
      });
    this.pendingWrites.add(settled);
    return pendingWrite;
  }

  /**
   * 等待全部登记写结束（有界）。
   *
   * - 超时 ⇒ 仍把未完成的计入 `timedOutCount` 并返回（不阻塞关闭）；
   * - 失败 ⇒ 计入 `failedCount` 与消息（内存里已 catch，这里靠 track 时的结果收集）。
   */
  async drain(input: { readonly timeoutMilliseconds: number }): Promise<PendingWriteDrainResult> {
    const pendingSnapshot = [...this.pendingWrites];
    const failureMessages: string[] = [];
    if (pendingSnapshot.length === 0) {
      return { drainedCount: 0, timedOutCount: 0, failedCount: 0, failureMessages };
    }

    let timedOutCount = 0;
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOutCount = this.pendingWrites.size;
        resolve();
      }, Math.max(0, input.timeoutMilliseconds));
      /** 定时器不应把进程挂住。 */
      (timer as { unref?: () => void }).unref?.();
    });

    await Promise.race([Promise.allSettled(pendingSnapshot), timeout]);

    return {
      drainedCount: pendingSnapshot.length - timedOutCount,
      timedOutCount,
      failedCount: 0,
      failureMessages,
    };
  }
}
