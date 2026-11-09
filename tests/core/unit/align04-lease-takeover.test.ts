/**
 * ALIGN-04-03（2026-11-09）：**租约幂等重入与过期接管**。
 *
 * 卡内 2026-10-28 记录"未跑'崩溃 running ⇒ 拒绝恢复''过期租约 ⇒ 接管成功'任何一条"。
 * 本文件覆盖租约侧的三条语义：
 *  ① 同进程重入 ⇒ `acquired-reentrant`（恢复不再把自己挡在门外）；
 *  ② 别的进程活跃租约 ⇒ `locked-active`（不得抢占）；
 *  ③ 过期租约 ⇒ 可按 revision CAS 接管；revision 不匹配 ⇒ 拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MissionLeaseStore } from "../../../packages/core/src/infra/mission-lease-store.js";

vi.setConfig({ testTimeout: 30_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lease-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

const MISSION_ID = "mission-lease-1";

/** 租约有效时长由**存储**决定（不是 claim 字段）：这里用可控时钟构造"过期"。 */
function buildStore(nowMilliseconds?: () => number) {
  return new MissionLeaseStore({
    stateDirectory,
    leaseTtlMilliseconds: 1_000,
    ...(nowMilliseconds === undefined ? {} : { nowMilliseconds }),
  });
}

function buildClaim(input: { readonly processInstanceId: string }) {
  return {
    missionId: MISSION_ID,
    processInstanceId: input.processInstanceId,
    purpose: "run" as const,
    claimantDescription: "测试进程",
  };
}

describe("ALIGN-04-03 mission 租约", () => {
  it("首次获取 ⇒ acquired", async () => {
    const store = buildStore();
    const outcome = await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    expect(outcome.status).toBe("acquired");
  }, 30_000);

  it("**同进程重入** ⇒ acquired-reentrant（不把自己挡在门外）", async () => {
    const store = buildStore();
    await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    const second = await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    expect(second.status).toBe("acquired-reentrant");
    expect(second.status).not.toBe("locked-active");
  }, 30_000);

  it("别的进程持有**活跃**租约 ⇒ locked-active（不得抢占）", async () => {
    const store = buildStore();
    await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    const other = await store.tryAcquire(buildClaim({ processInstanceId: "proc-B" }));
    expect(other.status).toBe("locked-active");
  }, 30_000);

  it("过期租约 ⇒ tryAcquire 报 locked-stale（提示需接管，而非直接抢占）", async () => {
    const store = buildStore();
    await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    /** 把时钟推到 TTL 之后 ⇒ 租约过期。 */
    const expiredStore = buildStore(() => Date.now() + 5_000);
    const other = await expiredStore.tryAcquire(buildClaim({ processInstanceId: "proc-B" }));
    expect(other.status).toBe("locked-stale");
  }, 30_000);

  it("**过期租约 + revision 正确** ⇒ 接管成功，属主变为新进程", async () => {
    const store = buildStore();
    await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    /** 把时钟推到 TTL 之后 ⇒ 租约过期。 */
    const expiredStore = buildStore(() => Date.now() + 5_000);
    const stale = await expiredStore.readLease(MISSION_ID);
    expect(stale).not.toBeNull();
    const takenOver = await expiredStore.takeOverExpiredLease(
      MISSION_ID,
      stale?.leaseRevision ?? 0,
      buildClaim({ processInstanceId: "proc-B" }),
    );
    expect(takenOver.processInstanceId).toBe("proc-B");
  }, 30_000);

  it("revision 不匹配 ⇒ 拒绝接管（stale-revision）", async () => {
    const store = buildStore();
    await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    /** 把时钟推到 TTL 之后 ⇒ 租约过期。 */
    const expiredStore = buildStore(() => Date.now() + 5_000);
    await expect(
      expiredStore.takeOverExpiredLease(MISSION_ID, 999, buildClaim({
        processInstanceId: "proc-B",
      })),
    ).rejects.toThrow(/revision/u);
  }, 30_000);

  it("**未过期**的租约 ⇒ 禁止接管（mission-locked）", async () => {
    const store = buildStore();
    await store.tryAcquire(buildClaim({ processInstanceId: "proc-A" }));
    const active = await store.readLease(MISSION_ID);
    await expect(
      store.takeOverExpiredLease(
        MISSION_ID,
        active?.leaseRevision ?? 0,
        buildClaim({ processInstanceId: "proc-B" }),
      ),
    ).rejects.toThrow(/禁止直接接管|locked/u);
  }, 30_000);
});
