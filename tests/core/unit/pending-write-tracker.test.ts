/**
 * SHUTDOWN-01（2026-11-17）：后台写收敛追踪。
 *
 * 反例来自实证：drill 用例删目录时后台原子写仍在飞 ⇒ `open(.tmp)` ENOENT。
 * 真实环境表现为"最后一次派生写静默丢失"（例如目标暂停标记没落盘）。
 */
import { describe, expect, it, vi } from "vitest";

import { PendingWriteTracker } from "../../../packages/core/src/orchestration/pending-write-tracker.js";

describe("后台写收敛", () => {
  it("① drain 会等待已登记写完成", async () => {
    const tracker = new PendingWriteTracker();
    let isCompleted = false;
    tracker.track(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          isCompleted = true;
          resolve();
        }, 20);
      }),
    );

    const result = await tracker.drain({ timeoutMilliseconds: 1_000 });
    expect(isCompleted).toBe(true);
    expect(result).toMatchObject({ drainedCount: 1, timedOutCount: 0 });
    expect(tracker.pendingCount).toBe(0);
  });

  it("② 超时 ⇒ 不挂死、如实报告未完成数量", async () => {
    const tracker = new PendingWriteTracker();
    tracker.track(new Promise<void>(() => undefined));

    const startedAt = Date.now();
    const result = await tracker.drain({ timeoutMilliseconds: 30 });
    const elapsed = Date.now() - startedAt;

    expect(result.timedOutCount).toBe(1);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("③ 写失败 ⇒ 不阻塞 drain，也不产生未处理拒绝", async () => {
    const tracker = new PendingWriteTracker();
    const failedWrite = tracker.track(Promise.reject(new Error("磁盘满")));
    await expect(failedWrite).rejects.toThrow(/磁盘满/u);

    /** 失败项已经结算并出队 ⇒ drain 时集合为空；关键是"不挂死、不产生未处理拒绝"。 */
    const result = await tracker.drain({ timeoutMilliseconds: 500 });
    expect(result).toMatchObject({ timedOutCount: 0 });
  });

  it("④ 空集合 ⇒ 立即返回", async () => {
    const tracker = new PendingWriteTracker();
    const result = await tracker.drain({ timeoutMilliseconds: 5_000 });
    expect(result).toMatchObject({ drainedCount: 0, timedOutCount: 0 });
  });

  it("⑤ 登记返回原 Promise（调用方仍可自行 catch，行为不变）", async () => {
    const tracker = new PendingWriteTracker();
    const original = Promise.resolve("ok");
    const handler = vi.fn((value: string) => value);
    const tracked = tracker.track(original.then(handler));
    await expect(tracked).resolves.toBe("ok");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
