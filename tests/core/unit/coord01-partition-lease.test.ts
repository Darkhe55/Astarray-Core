/**
 * COORD-01-02（卡 §4.1/§4.3/§7）：**分区租约 + fencing**。
 *
 * 反例优先：
 * - 两消费者同分区竞争 ⇒ 只有先到者获得，后者 `held-by-other`；
 * - 租约过期后接管 ⇒ fencing token 递增；
 * - **旧消费者迟提交** ⇒ `assertIsCurrentOwner` 必须为 false（这是 fencing 的唯一意义）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CoordinationPartitionLeaseStore,
  buildCoordinationPartitionKey,
} from "../../../packages/core/src/orchestration/coordination-partition-lease.js";

let stateDirectory: string;
let nowUnixMilliseconds: number;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-lease-"));
  nowUnixMilliseconds = 1_700_000_000_000;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStore() {
  return new CoordinationPartitionLeaseStore({
    stateDirectory,
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
}

const partitionKey = buildCoordinationPartitionKey({
  projectIdentifier: "project-alpha",
  schedulerAgentInstanceIdentifier: "scheduler-1",
});

describe("协调分区租约", () => {
  it("① 分区键必须同时含项目与调度个体；空值拒绝", () => {
    expect(partitionKey).toBe("project:project-alpha|scheduler:scheduler-1");
    expect(() =>
      buildCoordinationPartitionKey({ projectIdentifier: " ", schedulerAgentInstanceIdentifier: "s" }),
    ).toThrow();
    expect(() =>
      buildCoordinationPartitionKey({ projectIdentifier: "p", schedulerAgentInstanceIdentifier: "" }),
    ).toThrow();
  });

  it("② 同分区竞争 ⇒ 只有先到者获得，后者 held-by-other", async () => {
    const store = buildStore();
    const first = await store.tryAcquire({ partitionKey, ownerInstanceIdentifier: "consumer-a", ttlMilliseconds: 1000 });
    expect(first.outcome).toBe("acquired");
    const second = await store.tryAcquire({ partitionKey, ownerInstanceIdentifier: "consumer-b", ttlMilliseconds: 1000 });
    expect(second.outcome).toBe("held-by-other");
  });

  it("③ 过期接管 ⇒ fencing token 递增", async () => {
    const store = buildStore();
    const first = await store.tryAcquire({ partitionKey, ownerInstanceIdentifier: "consumer-a", ttlMilliseconds: 1000 });
    nowUnixMilliseconds += 2000;
    const takeover = await store.tryAcquire({ partitionKey, ownerInstanceIdentifier: "consumer-b", ttlMilliseconds: 1000 });
    expect(takeover.outcome).toBe("acquired");
    expect((first as { fencingToken: number }).fencingToken).toBe(1);
    expect((takeover as { fencingToken: number }).fencingToken).toBe(2);
  });

  it("④ **旧消费者迟提交 ⇒ 被 fencing 拦住**", async () => {
    const store = buildStore();
    const first = (await store.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 1000,
    })) as { fencingToken: number };
    nowUnixMilliseconds += 2000;
    await store.tryAcquire({ partitionKey, ownerInstanceIdentifier: "consumer-b", ttlMilliseconds: 1000 });

    const staleOwnerCheck = await store.assertIsCurrentOwner({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: first.fencingToken,
    });
    expect(staleOwnerCheck.isCurrentOwner).toBe(false);

    const currentOwnerCheck = await store.assertIsCurrentOwner({
      partitionKey,
      ownerInstanceIdentifier: "consumer-b",
      fencingToken: 2,
    });
    expect(currentOwnerCheck.isCurrentOwner).toBe(true);
  });

  it("⑤ 释放后旧 token 永久失效，新持有者 token 继续递增", async () => {
    const store = buildStore();
    const first = (await store.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      ttlMilliseconds: 1000,
    })) as { fencingToken: number };
    await store.releaseLease({ partitionKey, ownerInstanceIdentifier: "consumer-a", fencingToken: first.fencingToken });
    const afterRelease = await store.assertIsCurrentOwner({
      partitionKey,
      ownerInstanceIdentifier: "consumer-a",
      fencingToken: first.fencingToken,
    });
    expect(afterRelease.isCurrentOwner).toBe(false);
    const reclaimed = (await store.tryAcquire({
      partitionKey,
      ownerInstanceIdentifier: "consumer-b",
      ttlMilliseconds: 1000,
    })) as { fencingToken: number };
    expect(reclaimed.fencingToken).toBe(3);
  });
});
