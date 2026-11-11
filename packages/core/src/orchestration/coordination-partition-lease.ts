import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

/**
 * COORD-01-02（卡 §4.1/§4.3）：**协调分区租约**。
 *
 * 分区键 = 项目 ID + 责任调度 Agent 个体 ID。同一分区同一时刻只能有一个消费者提交状态，
 * 且必须用 **fencing token** 校验"我仍是当前所有者"——旧消费者过期后不得提交。
 *
 * 为什么单独一个 store 而不复用 `MissionLeaseStore`：mission 租约服务于"谁在跑这个 mission"，
 * 这里是"谁有权对这一段协调状态提交"，两者的键空间与失效语义不同；卡内也要求不把全部实现堆进 main-controller。
 */

export interface CoordinationPartitionKeyInput {
  readonly projectIdentifier: string;
  readonly schedulerAgentInstanceIdentifier: string;
}

/** 分区键：`project:<pid>|scheduler:<agent>`（两个部分都必须显式给出，不用默认值猜）。 */
export function buildCoordinationPartitionKey(input: CoordinationPartitionKeyInput): string {
  if (input.projectIdentifier.trim() === "") {
    throw new Error("协调分区缺少项目标识（不得以空值代替）");
  }
  if (input.schedulerAgentInstanceIdentifier.trim() === "") {
    throw new Error("协调分区缺少责任调度 Agent 个体标识（不得以空值代替）");
  }
  return `project:${input.projectIdentifier}|scheduler:${input.schedulerAgentInstanceIdentifier}`;
}

export interface CoordinationPartitionLeaseDocument {
  readonly schemaVersion: 1;
  readonly partitionKey: string;
  /** 当前所有者；无主时为 null。 */
  readonly ownerInstanceIdentifier: string | null;
  /** 单调递增的 fencing token：每次授权/接管都递增，旧 token 永久失效。 */
  readonly fencingToken: number;
  readonly expiresAtUnixMilliseconds: number | null;
}

export type CoordinationPartitionLeaseOutcome =
  | {
      readonly outcome: "acquired";
      readonly fencingToken: number;
      readonly expiresAtUnixMilliseconds: number;
    }
  | { readonly outcome: "held-by-other"; readonly expiresAtUnixMilliseconds: number }
  | { readonly outcome: "not-owner" }
  | { readonly outcome: "unknown-partition" };

export interface CoordinationPartitionLeaseStoreOptions {
  /** 租约落盘目录（每分区一个文件）。 */
  readonly stateDirectory: string;
  readonly nowUnixMilliseconds?: () => number;
}

function sanitizeFileName(partitionKey: string): string {
  return partitionKey.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

export class CoordinationPartitionLeaseStore {
  private readonly stateDirectory: string;
  private readonly nowUnixMilliseconds: () => number;

  constructor(options: CoordinationPartitionLeaseStoreOptions) {
    this.stateDirectory = options.stateDirectory;
    this.nowUnixMilliseconds = options.nowUnixMilliseconds ?? (() => Date.now());
  }

  private filePathFor(partitionKey: string): string {
    return path.join(this.stateDirectory, `${sanitizeFileName(partitionKey)}.json`);
  }

  async readLease(partitionKey: string): Promise<CoordinationPartitionLeaseDocument | null> {
    const primaryPath = this.filePathFor(partitionKey);
    const readResult = await readJsonWithBackupRecovery(primaryPath, `${primaryPath}.bak`);
    if (readResult === null) return null;
    /** `readJsonWithBackupRecovery` 返回的 `content` 已是解析后的对象。 */
    return readResult.content as CoordinationPartitionLeaseDocument;
  }

  private async writeLease(document: CoordinationPartitionLeaseDocument): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await writeAtomicJson(this.filePathFor(document.partitionKey), document);
  }

  /**
   * 取租约。分区被他人持有且未过期 ⇒ `held-by-other`；已过期或无主 ⇒ 接管并**递增 fencing token**。
   */
  async tryAcquire(input: {
    partitionKey: string;
    ownerInstanceIdentifier: string;
    ttlMilliseconds: number;
  }): Promise<CoordinationPartitionLeaseOutcome> {
    if (input.ttlMilliseconds <= 0) {
      throw new Error("租约 TTL 必须是正数（毫秒）");
    }
    const now = this.nowUnixMilliseconds();
    const existing = await this.readLease(input.partitionKey);
    if (
      existing !== null &&
      existing.ownerInstanceIdentifier !== null &&
      existing.expiresAtUnixMilliseconds !== null &&
      existing.expiresAtUnixMilliseconds > now
    ) {
      /**
       * 同一持有者再次获取 ⇒ **幂等复用**（不递增 token）。
       * 否则"自己已持锁再问一次"会被判成 held-by-other，崩溃恢复时会误以为拿不到租约。
       */
      if (existing.ownerInstanceIdentifier === input.ownerInstanceIdentifier) {
        return {
          outcome: "acquired",
          fencingToken: existing.fencingToken,
          expiresAtUnixMilliseconds: existing.expiresAtUnixMilliseconds,
        };
      }
      return {
        outcome: "held-by-other",
        expiresAtUnixMilliseconds: existing.expiresAtUnixMilliseconds,
      };
    }
    const fencingToken = (existing?.fencingToken ?? 0) + 1;
    const expiresAtUnixMilliseconds = now + input.ttlMilliseconds;
    await this.writeLease({
      schemaVersion: 1,
      partitionKey: input.partitionKey,
      ownerInstanceIdentifier: input.ownerInstanceIdentifier,
      fencingToken,
      expiresAtUnixMilliseconds,
    });
    return { outcome: "acquired", fencingToken, expiresAtUnixMilliseconds };
  }

  /** 续租：token 必须是当前值且未过期，否则 `not-owner`。 */
  async renewLease(input: {
    partitionKey: string;
    ownerInstanceIdentifier: string;
    fencingToken: number;
    ttlMilliseconds: number;
  }): Promise<CoordinationPartitionLeaseOutcome> {
    const existing = await this.readLease(input.partitionKey);
    if (existing === null) return { outcome: "unknown-partition" };
    const now = this.nowUnixMilliseconds();
    if (
      existing.fencingToken !== input.fencingToken ||
      existing.ownerInstanceIdentifier !== input.ownerInstanceIdentifier ||
      existing.expiresAtUnixMilliseconds === null ||
      existing.expiresAtUnixMilliseconds <= now
    ) {
      return { outcome: "not-owner" };
    }
    const expiresAtUnixMilliseconds = now + input.ttlMilliseconds;
    await this.writeLease({ ...existing, expiresAtUnixMilliseconds });
    return {
      outcome: "acquired",
      fencingToken: existing.fencingToken,
      expiresAtUnixMilliseconds,
    };
  }

  /** 主动释放：清空所有者但**保留并递增** token，使旧 token 永久失效。 */
  async releaseLease(input: {
    partitionKey: string;
    ownerInstanceIdentifier: string;
    fencingToken: number;
  }): Promise<CoordinationPartitionLeaseOutcome> {
    const existing = await this.readLease(input.partitionKey);
    if (existing === null) return { outcome: "unknown-partition" };
    if (
      existing.fencingToken !== input.fencingToken ||
      existing.ownerInstanceIdentifier !== input.ownerInstanceIdentifier
    ) {
      return { outcome: "not-owner" };
    }
    await this.writeLease({
      ...existing,
      ownerInstanceIdentifier: null,
      fencingToken: existing.fencingToken + 1,
      expiresAtUnixMilliseconds: null,
    });
    return { outcome: "acquired", fencingToken: existing.fencingToken + 1, expiresAtUnixMilliseconds: 0 };
  }

  /**
   * 提交前校验：只有当前所有者且未过期才能提交。
   * 这是"旧消费者迟提交"的唯一拦截点——不校验就等于没有 fencing。
   */
  async assertIsCurrentOwner(input: {
    partitionKey: string;
    ownerInstanceIdentifier: string;
    fencingToken: number;
  }): Promise<{ readonly isCurrentOwner: boolean }> {
    const existing = await this.readLease(input.partitionKey);
    if (existing === null) return { isCurrentOwner: false };
    const now = this.nowUnixMilliseconds();
    const isCurrentOwner =
      existing.fencingToken === input.fencingToken &&
      existing.ownerInstanceIdentifier === input.ownerInstanceIdentifier &&
      existing.expiresAtUnixMilliseconds !== null &&
      existing.expiresAtUnixMilliseconds > now;
    return { isCurrentOwner };
  }
}
