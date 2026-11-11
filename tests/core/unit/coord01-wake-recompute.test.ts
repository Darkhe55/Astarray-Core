/**
 * COORD-01-02（卡 §4.5）：**唤醒 → 重算 ready set**。
 *
 * 反例优先：
 * - 无新唤醒 ⇒ **不重算**（避免把"唤醒"当成"再启动一次任务"的空转）；
 * - 有新唤醒 ⇒ 重算一次并推进已消费计数；
 * - 同一批唤醒重复调用 ⇒ 第二次不再重算（幂等）；
 * - 重算抛错 ⇒ 计数**不推进**，下一轮重试（不能把失败当已消费）；
 * - 重启后已消费计数保留（新实例不重复消费）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CoordinationStateTransactionStore } from "../../../packages/core/src/orchestration/coordination-state-transaction.js";
import { CoordinationWakeCoordinator } from "../../../packages/core/src/orchestration/coordination-wake-coordinator.js";
import { CoordinationPartitionLeaseStore } from "../../../packages/core/src/orchestration/coordination-partition-lease.js";

let stateDirectory: string;
const partitionKey = "project:project-alpha|scheduler:scheduler-1";
let nowUnixMilliseconds: number;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-wake-"));
  nowUnixMilliseconds = 1_700_000_000_000;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildHarness() {
  const leaseStore = new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(stateDirectory, "leases"),
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  const stateStore = new CoordinationStateTransactionStore({
    stateDirectory: path.join(stateDirectory, "state"),
    leaseStore,
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
  return { leaseStore, stateStore, coordinator: new CoordinationWakeCoordinator({ stateStore }) };
}

async function applyOnce(stateStore: CoordinationStateTransactionStore, leaseStore: CoordinationPartitionLeaseStore, messageId: string) {
  await stateStore.ensurePartitionState({ partitionKey });
  const lease = (await leaseStore.tryAcquire({
    partitionKey,
    ownerInstanceIdentifier: "consumer-a",
    ttlMilliseconds: 60_000,
  })) as { fencingToken: number };
  const outcome = await stateStore.applyMessage({
    partitionKey,
    ownerInstanceIdentifier: "consumer-a",
    fencingToken: lease.fencingToken,
    messageIdentifier: messageId,
    expectedStateVersion: (await stateStore.readState(partitionKey))?.stateVersion ?? 0,
    nextSnapshot: { applied: messageId },
  });
  expect(outcome.outcome).toBe("applied");
}

describe("唤醒 → 重算 ready set", () => {
  it("① 无唤醒 ⇒ 不重算（selection 为 null，不伪造空结果）", async () => {
    const { stateStore, coordinator } = buildHarness();
    await stateStore.ensurePartitionState({ partitionKey });
    let callCount = 0;
    const result = await coordinator.recomputeIfWakePending({
      partitionKey,
      selectReadyTasks: async () => {
        callCount += 1;
        return ["T-001"];
      },
    });
    expect(result.isRecomputed).toBe(false);
    expect(result.selection).toBeNull();
    expect(callCount).toBe(0);
  });

  it("② 有新唤醒 ⇒ 重算一次并推进已消费计数", async () => {
    const { stateStore, leaseStore, coordinator } = buildHarness();
    await applyOnce(stateStore, leaseStore, "message-1");
    const result = await coordinator.recomputeIfWakePending({
      partitionKey,
      selectReadyTasks: async () => ["T-001"],
    });
    expect(result.isRecomputed).toBe(true);
    expect(result.selection).toEqual(["T-001"]);
    expect(result.consumedWakeCount).toBe(1);
  });

  it("③ 同一唤醒重复调用 ⇒ 第二次不再重算（幂等）", async () => {
    const { stateStore, leaseStore, coordinator } = buildHarness();
    await applyOnce(stateStore, leaseStore, "message-1");
    await coordinator.recomputeIfWakePending({ partitionKey, selectReadyTasks: async () => ["T-001"] });
    let callCount = 0;
    const second = await coordinator.recomputeIfWakePending({
      partitionKey,
      selectReadyTasks: async () => {
        callCount += 1;
        return ["T-001"];
      },
    });
    expect(second.isRecomputed).toBe(false);
    expect(callCount).toBe(0);
  });

  it("④ 重算抛错 ⇒ 计数不推进，下一轮重试", async () => {
    const { stateStore, leaseStore, coordinator } = buildHarness();
    await applyOnce(stateStore, leaseStore, "message-1");
    await expect(
      coordinator.recomputeIfWakePending({
        partitionKey,
        selectReadyTasks: async () => {
          throw new Error("ready-set-boom");
        },
      }),
    ).rejects.toThrow(/ready-set-boom/u);
    const retry = await coordinator.recomputeIfWakePending({
      partitionKey,
      selectReadyTasks: async () => ["T-002"],
    });
    expect(retry.isRecomputed).toBe(true);
    expect(retry.selection).toEqual(["T-002"]);
  });

  it("⑤ 重启后已消费计数保留，不重复消费", async () => {
    const { stateStore, leaseStore, coordinator } = buildHarness();
    await applyOnce(stateStore, leaseStore, "message-1");
    await coordinator.recomputeIfWakePending({ partitionKey, selectReadyTasks: async () => ["T-001"] });

    const restartedLeaseStore = new CoordinationPartitionLeaseStore({
      stateDirectory: path.join(stateDirectory, "leases"),
      nowUnixMilliseconds: () => nowUnixMilliseconds,
    });
    const restartedStateStore = new CoordinationStateTransactionStore({
      stateDirectory: path.join(stateDirectory, "state"),
      leaseStore: restartedLeaseStore,
      nowUnixMilliseconds: () => nowUnixMilliseconds,
    });
    const restartedCoordinator = new CoordinationWakeCoordinator({ stateStore: restartedStateStore });
    const result = await restartedCoordinator.recomputeIfWakePending({
      partitionKey,
      selectReadyTasks: async () => ["T-001"],
    });
    expect(result.isRecomputed).toBe(false);
  });
});
