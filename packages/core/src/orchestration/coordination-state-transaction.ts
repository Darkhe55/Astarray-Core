import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import type { CoordinationPartitionLeaseStore } from "./coordination-partition-lease.js";

/**
 * COORD-01-02（卡 §4.3/§4.4）：协调分区的**短状态事务**。
 *
 * 顺序固定：① 校验仍是当前租约所有者（fencing）→ ② 幂等：该消息已应用则复用结论
 * → ③ CAS：状态版本不符即 stale（不改状态、不释放槽位）→ ④ 落盘并**置待唤醒标志**。
 *
 * 事务内不做模型调用、工具执行、网络或等待授权（那些在事务外）。
 * 幂等键是 `messageIdentifier`，且与状态更新**同一次原子写**落盘——崩溃后能判断"是否已应用"。
 */

export interface AppliedMessageRecord {
  readonly messageIdentifier: string;
  readonly appliedAtIso: string;
  /** 应用后的权威状态版本。 */
  readonly resultingStateVersion: number;
}

export interface CoordinationPartitionStateDocument {
  readonly schemaVersion: 1;
  readonly partitionKey: string;
  /** 权威状态版本（CAS 依据）。 */
  readonly stateVersion: number;
  /** 最后一次应用快照（本地可信状态，非模型自述）。 */
  readonly snapshot: Record<string, unknown> | null;
  readonly appliedMessages: readonly AppliedMessageRecord[];
  /** 待唤醒标志：可重复消费的"重算 ready set"信号计数。 */
  readonly pendingWakeCount: number;
  /** 已消费的唤醒计数（用于判断"是否有新唤醒待处理"，不删除历史）。 */
  readonly consumedWakeCount?: number;
}

export type CoordinationApplyOutcome =
  | { readonly outcome: "applied"; readonly stateVersion: number; readonly isWakeRequested: true }
  | { readonly outcome: "idempotent-replay"; readonly stateVersion: number }
  | { readonly outcome: "stale"; readonly currentStateVersion: number }
  | { readonly outcome: "not-owner" }
  | { readonly outcome: "not-found" };

export interface CoordinationStateTransactionStoreOptions {
  readonly stateDirectory: string;
  readonly leaseStore: CoordinationPartitionLeaseStore;
  readonly nowUnixMilliseconds?: () => number;
}

function sanitizeFileName(partitionKey: string): string {
  return partitionKey.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export class CoordinationStateTransactionStore {
  private readonly stateDirectory: string;
  private readonly leaseStore: CoordinationPartitionLeaseStore;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: CoordinationStateTransactionStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.leaseStore = options.leaseStore;
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
  }

  private filePathFor(partitionKey: string): string {
    return path.join(this.stateDirectory, `${sanitizeFileName(partitionKey)}.json`);
  }

  async readState(partitionKey: string): Promise<CoordinationPartitionStateDocument | null> {
    const primaryPath = this.filePathFor(partitionKey);
    const readResult = await readJsonWithBackupRecovery(primaryPath, `${primaryPath}.bak`);
    if (readResult === null) return null;
    return readResult.content as CoordinationPartitionStateDocument;
  }

  private async writeState(document: CoordinationPartitionStateDocument): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await writeAtomicJson(this.filePathFor(document.partitionKey), document);
  }

  /**
   * 应用一条消息到权威状态。
   *
   * `expectedStateVersion` 来自消费侧读到的版本；不匹配即 `stale`——**不猜测应用**，
   * 由上层走有界对账。
   */
  async applyMessage(input: {
    partitionKey: string;
    ownerInstanceIdentifier: string;
    fencingToken: number;
    messageIdentifier: string;
    expectedStateVersion: number;
    nextSnapshot: Record<string, unknown>;
  }): Promise<CoordinationApplyOutcome> {
    /** ① fencing：旧消费者即便拿到更早的版本号也不得提交。 */
    const ownership = await this.leaseStore.assertIsCurrentOwner({
      partitionKey: input.partitionKey,
      ownerInstanceIdentifier: input.ownerInstanceIdentifier,
      fencingToken: input.fencingToken,
    });
    if (!ownership.isCurrentOwner) return { outcome: "not-owner" };

    const existing = await this.readState(input.partitionKey);
    if (existing === null) return { outcome: "not-found" };

    /** ② 幂等：同消息重复投递 / 恢复重放 ⇒ 复用原结论，不重复唤醒。 */
    const alreadyApplied = existing.appliedMessages.find(
      (record) => record.messageIdentifier === input.messageIdentifier,
    );
    if (alreadyApplied !== undefined) {
      return { outcome: "idempotent-replay", stateVersion: alreadyApplied.resultingStateVersion };
    }

    /** ③ CAS：版本不符 ⇒ stale，不改状态、不释放槽位。 */
    if (existing.stateVersion !== input.expectedStateVersion) {
      return { outcome: "stale", currentStateVersion: existing.stateVersion };
    }

    /** ④ 状态与幂等记录**同一次原子写**落盘。 */
    const resultingStateVersion = existing.stateVersion + 1;
    await this.writeState({
      ...existing,
      stateVersion: resultingStateVersion,
      snapshot: input.nextSnapshot,
      appliedMessages: [
        ...existing.appliedMessages,
        {
          messageIdentifier: input.messageIdentifier,
          appliedAtIso: new Date(this.nowUnixMilliseconds()).toISOString(),
          resultingStateVersion,
        },
      ],
      pendingWakeCount: existing.pendingWakeCount + 1,
    });
    return { outcome: "applied", stateVersion: resultingStateVersion, isWakeRequested: true };
  }

  /** 初始化分区状态（幂等：已存在则原样返回）。 */
  async ensurePartitionState(input: {
    partitionKey: string;
    initialSnapshot?: Record<string, unknown> | null;
  }): Promise<CoordinationPartitionStateDocument> {
    const existing = await this.readState(input.partitionKey);
    if (existing !== null) return existing;
    const created: CoordinationPartitionStateDocument = {
      schemaVersion: 1,
      partitionKey: input.partitionKey,
      stateVersion: 0,
      snapshot: input.initialSnapshot ?? null,
      appliedMessages: [],
      pendingWakeCount: 0,
    };
    await this.writeState(created);
    return created;
  }

  /** 记录唤醒已被消费到某个计数（只推进、不回退）。 */
  async markWakeConsumed(input: {
    partitionKey: string;
    wakeCount: number;
  }): Promise<void> {
    const existing = await this.readState(input.partitionKey);
    if (existing === null) return;
    const currentConsumed = existing.consumedWakeCount ?? 0;
    if (input.wakeCount <= currentConsumed) return;
    await this.writeState({ ...existing, consumedWakeCount: input.wakeCount });
  }

  /**
   * 消费端取"待唤醒"信号：返回当前计数供调用方重算 ready set。
   * 只读，不清零——唤醒是可重复信号，不是一次性事件。
   */
  async readPendingWakeCount(partitionKey: string): Promise<number> {
    const existing = await this.readState(partitionKey);
    return existing?.pendingWakeCount ?? 0;
  }
}
