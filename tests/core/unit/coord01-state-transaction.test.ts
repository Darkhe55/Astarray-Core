/**
 * COORD-01-02（卡 §4.3/§4.4/§7）：协调分区**短状态事务**。
 *
 * 反例优先：
 * - 同消息重复投递 ⇒ 只应用一次、**不重复唤醒**；
 * - 状态版本不符 ⇒ `stale`，不改状态；
 * - **旧 fencing token 提交 ⇒ `not-owner`**（事务内先校验所有权）；
 * - 崩溃恢复：新实例读到已应用记录与待唤醒计数，不重复应用。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CoordinationPartitionLeaseStore,
  buildCoordinationPartitionKey,
} from "../../../packages/core/src/orchestration/coordination-partition-lease.js";
import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";

let stateDirectory: string;
let nowUnixMilliseconds: number;
let partitionKey: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-txn-"));
  nowUnixMilliseconds = 1_700_000_000_000;
  partitionKey = buildCoordinationPartitionKey({
    projectIdentifier: "project-alpha",
    schedulerAgentInstanceIdentifier: "scheduler-1",
  });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStores() {
  const leaseStore = new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(stateDirectory, "leases"),
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  const transactionStore = new CoordinationStateTransactionStore({
    stateDirectory: path.join(stateDirectory, "state"),
    leaseStore,
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  return { leaseStore, transactionStore };
}

describe("协调分区短事务", () => {
  it("① 首次应用 ⇒ applied 且置待唤醒标志", async () => {
    const { leaseStore, transactionStore } = buildStores();
    await transactionStore.ensurePartitionState({ partitionKey });
    const lease = (await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 60_000,
    })) as { fencingToken: number };

    const outcome = await transactionStore.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: lease.fencingToken,
      messageIdentifier: "message-1",
      expectedStateVersion: 0,
      nextSnapshot: { status: "applied-1" },
    });
    expect(outcome).toMatchObject({ outcome: "applied", stateVersion: 1, isWakeRequested: true });
    expect(await transactionStore.readPendingWakeCount(partitionKey)).toBe(1);
  });

  it("② 同消息重复投递 ⇒ idempotent-replay 且**不重复唤醒**", async () => {
    const { leaseStore, transactionStore } = buildStores();
    await transactionStore.ensurePartitionState({ partitionKey });
    const lease = (await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 60_000,
    })) as { fencingToken: number };
    const input = {
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: lease.fencingToken,
      messageIdentifier: "message-1",
      expectedStateVersion: 0,
      nextSnapshot: { status: "applied-1" },
    };
    await transactionStore.applyMessage(input);
    const replay = await transactionStore.applyMessage(input);
    expect(replay.outcome).toBe("idempotent-replay");
    expect(await transactionStore.readPendingWakeCount(partitionKey)).toBe(1);
  });

  it("③ 状态版本不符 ⇒ stale，状态不变", async () => {
    const { leaseStore, transactionStore } = buildStores();
    await transactionStore.ensurePartitionState({ partitionKey });
    const lease = (await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 60_000,
    })) as { fencingToken: number };
    const stale = await transactionStore.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: lease.fencingToken,
      messageIdentifier: "message-x",
      expectedStateVersion: 7,
      nextSnapshot: { status: "wrong" },
    });
    expect(stale).toEqual({ outcome: "stale", currentStateVersion: 0 });
    expect(await transactionStore.readPendingWakeCount(partitionKey)).toBe(0);
  });

  it("④ 旧 fencing token 提交 ⇒ not-owner，状态不变", async () => {
    const { leaseStore, transactionStore } = buildStores();
    await transactionStore.ensurePartitionState({ partitionKey });
    const firstLease = (await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 1000,
    })) as { fencingToken: number };
    nowUnixMilliseconds += 2000;
    await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-b",
      ttlMilliseconds: 60_000,
    });

    const staleOwner = await transactionStore.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: firstLease.fencingToken,
      messageIdentifier: "message-1",
      expectedStateVersion: 0,
      nextSnapshot: { status: "late" },
    });
    expect(staleOwner).toEqual({ outcome: "not-owner" });
    expect(await transactionStore.readPendingWakeCount(partitionKey)).toBe(0);
  });

  it("⑤ 崩溃恢复：新实例读到已应用记录与唤醒计数，不重复应用", async () => {
    const { leaseStore, transactionStore } = buildStores();
    await transactionStore.ensurePartitionState({ partitionKey });
    const lease = (await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 60_000,
    })) as { fencingToken: number };
    await transactionStore.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: lease.fencingToken,
      messageIdentifier: "message-1",
      expectedStateVersion: 0,
      nextSnapshot: { status: "applied-1" },
    });

    /** 模拟重启：新实例（同一目录）读回状态。 */
    const restarted = buildStores().transactionStore;
    const state = await restarted.readState(partitionKey);
    expect(state?.appliedMessages.map((record) => record.messageIdentifier)).toEqual(["message-1"]);
    expect(await restarted.readPendingWakeCount(partitionKey)).toBe(1);
    const replay = await restarted.applyMessage({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: lease.fencingToken,
      messageIdentifier: "message-1",
      expectedStateVersion: 0,
      nextSnapshot: { status: "applied-1" },
    });
    /** 租约仍在有效期内 ⇒ 所有权通过，但幂等记录使其不重复应用。 */
    expect(replay.outcome).toBe("idempotent-replay");
  });
});
