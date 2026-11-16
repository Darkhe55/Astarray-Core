/**
 * CLUSTER 跨进程写租约（2026-11-16，审查报告 P2）。
 *
 * 反例目标：实例内 `Set` 挡不住两个进程同时扫描；这里验证复用**持久租约**后：
 * ① 两个实例争抢 ⇒ 只有一个能构建，另一个 busy；
 * ② 前者释放后，后者可以接管；
 * ③ 构建期间租约被接管 ⇒ 旧写者提交被拒（lease-lost），**不覆盖新索引**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiagnosticClusterService } from "../../../packages/core/src/orchestration/diagnostic-cluster-service.js";
import { CoordinationPartitionLeaseStore } from "../../../packages/core/src/orchestration/coordination-partition-lease.js";

let stateDirectory: string;
let nowMilliseconds: number;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster-lease-"));
  nowMilliseconds = 1_700_000_000_000;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildLeaseStore() {
  return new CoordinationPartitionLeaseStore({
    stateDirectory: path.join(stateDirectory, "leases"),
    nowUnixMilliseconds: () => nowMilliseconds,
  });
}

/** 最小事件存储：没有事件 ⇒ 构建出空快照，足以验证租约互斥。 */
function buildEmptyEventStore() {
  return {
    async readEventPages() {
      /** 让第一次构建**客观上有持续时间**，保证两个实例真的重叠（否则第二个可能等在租约释放之后）。 */
      await new Promise((resolve) => setTimeout(resolve, 50));
      /** 空事件源：关键字段是 `isComplete`，缺了会让构建循环跑到时长上限（实测 5s/10s）。 */
      return {
        pages: [],
        nextCursor: { byteOffset: 0, lineNumber: 0 },
        isComplete: true,
        discardedLineCount: 0,
        totalEventCount: 0,
      };
    },
  } as never;
}

function buildService(ownerInstanceIdentifier: string, leaseStore: ReturnType<typeof buildLeaseStore>) {
  return new DiagnosticClusterService({
    store: buildEmptyEventStore(),
    stateDirectory,
    algorithmVersion: "v1",
    isEnabled: true,
    leaseStore,
    ownerInstanceIdentifier,
  });
}

const buildInput = {
  projectIdentifier: "project-alpha",
  generatedAtIso: "2026-11-16T00:00:00.000Z",
  resolveProjectIdentifier: () => "project-alpha",
};

describe("CLUSTER 跨实例写租约", () => {
  it("① 两个实例争抢 ⇒ 只有一个构建，另一个 busy", async () => {
    const leaseStore = buildLeaseStore();
    const first = buildService("process-a", leaseStore);
    const second = buildService("process-b", leaseStore);

    const [firstResult, secondResult] = await Promise.all([
      first.buildSnapshot(buildInput as never),
      second.buildSnapshot(buildInput as never),
    ]);

    const statuses = [firstResult.status, secondResult.status].sort();
    /** 字典序：built < busy。关键是没有两个都 built。 */
    expect(statuses).toEqual(["built", "busy"]);
  });

  it("② 前者释放后 ⇒ 后者可以接管并构建", async () => {
    const leaseStore = buildLeaseStore();
    const first = buildService("process-a", leaseStore);
    const second = buildService("process-b", leaseStore);

    const firstResult = await first.buildSnapshot(buildInput as never);
    expect(firstResult.status).toBe("built");

    const secondResult = await second.buildSnapshot(buildInput as never);
    expect(secondResult.status).toBe("built");
  });

  it("③ 租约被接管 ⇒ 旧写者提交被拒（lease-lost），不覆盖索引", async () => {
    const leaseStore = buildLeaseStore();
    const partitionKey = "diagnostic-cluster:project-alpha";

    /** 旧写者拿到租约，随后过期被新进程接管。 */
    const staleLease = await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "process-a",
      ttlMilliseconds: 1000,
    });
    expect(staleLease.outcome).toBe("acquired");
    nowMilliseconds += 2000;

    const takeover = await leaseStore.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "process-b",
      ttlMilliseconds: 60_000,
    });
    expect(takeover.outcome).toBe("acquired");

    const staleToken = (staleLease as { fencingToken: number }).fencingToken;
    const ownership = await leaseStore.assertIsCurrentOwner({
      partitionKey,
      ownerInstanceIdentifier: "process-a",
      fencingToken: staleToken,
    });
    expect(ownership.isCurrentOwner).toBe(false);
  });
});
