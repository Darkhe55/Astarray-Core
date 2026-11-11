import type { CoordinationStateTransactionStore } from "./coordination-state-transaction.js";

/**
 * COORD-01-02（卡 §4.5）：**唤醒 → 重算 ready set**。
 *
 * 卡内语义要点：
 * - 唤醒是**可重复的"重新计算 ready set"信号**，不是"直接再启动一次任务"；
 * - 重算本身不派发：派发仍走既有租约与幂等接口（本协调器不新建派发通道）；
 * - 已消费的唤醒计数**持久化**，崩溃后不会被重复消费，也不会丢失未处理的新唤醒。
 */
export interface CoordinationWakeRecomputationResult<Selection> {
  /** 本次是否真的执行了重算（无新唤醒时为 false）。 */
  readonly isRecomputed: boolean;
  readonly pendingWakeCount: number;
  readonly consumedWakeCount: number;
  /** 重算结果；未重算时为 null（不伪造成空结果）。 */
  readonly selection: Selection | null;
}

export interface CoordinationWakeCoordinatorOptions {
  readonly stateStore: CoordinationStateTransactionStore;
}

export class CoordinationWakeCoordinator {
  private readonly stateStore: CoordinationStateTransactionStore;

  constructor(options: CoordinationWakeCoordinatorOptions) {
    this.stateStore = options.stateStore;
  }

  /**
   * 若有**新的**唤醒（pending > consumed），执行一次重算并推进已消费计数。
   * 重算只读，不派发、不启动任务。
   */
  async recomputeIfWakePending<Selection>(input: {
    partitionKey: string;
    selectReadyTasks: () => Promise<Selection>;
  }): Promise<CoordinationWakeRecomputationResult<Selection>> {
    const state = await this.stateStore.readState(input.partitionKey);
    if (state === null) {
      return {
        isRecomputed: false,
        pendingWakeCount: 0,
        consumedWakeCount: 0,
        selection: null,
      };
    }
    const consumedWakeCount = state.consumedWakeCount ?? 0;
    if (state.pendingWakeCount <= consumedWakeCount) {
      return {
        isRecomputed: false,
        pendingWakeCount: state.pendingWakeCount,
        consumedWakeCount,
        selection: null,
      };
    }

    const selection = await input.selectReadyTasks();
    /** 先重算成功再推进计数：重算抛错时保持未消费，下一轮会重试。 */
    await this.stateStore.markWakeConsumed({
      partitionKey: input.partitionKey,
      wakeCount: state.pendingWakeCount,
    });
    return {
      isRecomputed: true,
      pendingWakeCount: state.pendingWakeCount,
      consumedWakeCount: state.pendingWakeCount,
      selection,
    };
  }
}
