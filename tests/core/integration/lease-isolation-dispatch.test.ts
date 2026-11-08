/**
 * ALIGN-02-05（2026-11-08）：**租约隔离下不误派发**。
 *
 * 目标态（卡内要求）：任务领取必须绑定"谁在执行"；租约仍活跃的 mission
 * 不得被另一进程实例接管（否则会重复副作用），租约过期后才能接管。
 *
 * 钉住四件事：
 * 1. 同 mission 二次申请 ⇒ `locked-active`，属主不被覆盖；
 * 2. 同进程重入 ⇒ `acquired-reentrant`（恢复/重试不被自己挡住）；
 * 3. 活跃租约禁止接管；过期后可用正确 revision 接管；
 * 4. 接管 revision 不匹配 ⇒ `stale-revision`（不盲目覆盖）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MissionLeaseStore } from "../../../packages/core/src/infra/mission-lease-store.js";

let temporaryDirectory: string;
let store: MissionLeaseStore;
const missionId = "mission-lease-test";
const shortLeaseMilliseconds = 300;
const baseClaim = {
  missionId,
  processInstanceId: "process-A",
  purpose: "run" as const,
  claimantDescription: "测试用租约",
};

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lease-"));
  store = new MissionLeaseStore({
    stateDirectory: temporaryDirectory,
    leaseTtlMilliseconds: shortLeaseMilliseconds,
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("租约隔离（ALIGN-02-05）", () => {
  it("同 mission 二次申请 ⇒ locked-active，属主不被覆盖", async () => {
    const first = await store.tryAcquire(baseClaim);
    expect(first.status).toBe("acquired");
    const second = await store.tryAcquire({
      ...baseClaim,
      processInstanceId: "process-B",
    });
    expect(second.status).toBe("locked-active");
    const current = await store.readLease(missionId);
    expect(current?.processInstanceId).toBe("process-A");
  });

  it("同进程重入是幂等的（恢复/重试不被自己挡住）", async () => {
    const first = await store.tryAcquire(baseClaim);
    expect(first.status).toBe("acquired");
    const reentrant = await store.tryAcquire(baseClaim);
    expect(reentrant.status).toBe("acquired-reentrant");
  });

  it("租约活跃时禁止接管；过期后可用正确 revision 接管并换属主", async () => {
    const first = await store.tryAcquire(baseClaim);
    expect(first.status).toBe("acquired");
    const lease = await store.readLease(missionId);
    expect(lease?.leaseRevision).toBe(1);

    await expect(
      store.takeOverExpiredLease(missionId, 1, {
        ...baseClaim,
        processInstanceId: "process-B",
      }),
    ).rejects.toThrow(/租约仍活跃/u);

    /** 等租约过期（短 TTL + 真实等待）。 */
    await new Promise((resolve) => setTimeout(resolve, shortLeaseMilliseconds + 100));
    const takenOver = await store.takeOverExpiredLease(missionId, 1, {
      ...baseClaim,
      processInstanceId: "process-B",
    });
    expect(takenOver.processInstanceId).toBe("process-B");
    expect(takenOver.leaseRevision).toBe(2);
  });

  it("接管 revision 不匹配 ⇒ stale-revision（不盲目覆盖）", async () => {
    const first = await store.tryAcquire(baseClaim);
    expect(first.status).toBe("acquired");
    await new Promise((resolve) => setTimeout(resolve, shortLeaseMilliseconds + 100));
    await expect(
      store.takeOverExpiredLease(missionId, 99, {
        ...baseClaim,
        processInstanceId: "process-B",
      }),
    ).rejects.toThrow(/接管 revision 不匹配/u);
  });

  it("不存在的租约不可接管", async () => {
    await expect(
      store.takeOverExpiredLease("mission-missing", 1, {
        ...baseClaim,
        missionId: "mission-missing",
        processInstanceId: "process-B",
      }),
    ).rejects.toThrow(/不存在可接管的 mission 租约/u);
  });

  it("非属主续约被拒（旧执行者不能延长自己的租约）", async () => {
    const first = await store.tryAcquire(baseClaim);
    expect(first.status).toBe("acquired");
    await expect(
      store.renewLease(missionId, 1, "process-B"),
    ).rejects.toThrow();
  });
});
