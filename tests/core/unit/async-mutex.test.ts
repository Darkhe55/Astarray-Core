/**
 * 进程内异步互斥锁（此前 `tests/` 零引用）。
 *
 * 这是几十个存储模块依赖的底层件：它的缺陷会表现为**别处**的随机失败，
 * 所以这里对四条必须成立的性质单独设防：串行、异常释放、FIFO、实例隔离。
 */
import { describe, expect, it } from "vitest";

import { AsyncMutex } from "../../../packages/core/src/infra/async-mutex.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("AsyncMutex", () => {
  it("① 临界区不重叠：并发任务按序串行执行", async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];

    const first = mutex.runExclusive(async () => {
      events.push("first-enter");
      await delay(20);
      events.push("first-exit");
    });
    const second = mutex.runExclusive(async () => {
      events.push("second-enter");
      await delay(1);
      events.push("second-exit");
    });
    await Promise.all([first, second]);

    expect(events).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
  });

  it("② 同一时刻最多一个任务在临界区（并发 5 个）", async () => {
    const mutex = new AsyncMutex();
    let activeCount = 0;
    let maximumActiveCount = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        mutex.runExclusive(async () => {
          activeCount += 1;
          maximumActiveCount = Math.max(maximumActiveCount, activeCount);
          await delay(5);
          activeCount -= 1;
        }),
      ),
    );

    expect(maximumActiveCount).toBe(1);
    expect(activeCount).toBe(0);
  });

  it("③ 任务抛错后锁**必须释放**（第二个任务仍能执行，不死锁）", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => {
        throw new Error("任务失败");
      }),
    ).rejects.toThrow("任务失败");

    const result = await mutex.runExclusive(async () => "第二个任务执行了");
    expect(result).toBe("第二个任务执行了");
  });

  it("④ 返回值原样透传（含 undefined 与复杂对象）", async () => {
    const mutex = new AsyncMutex();
    expect(await mutex.runExclusive(async () => 42)).toBe(42);
    expect(await mutex.runExclusive(async () => undefined)).toBeUndefined();
    const payload = { a: 1, b: [2, 3] };
    expect(await mutex.runExclusive(async () => payload)).toBe(payload);
  });

  it("⑤ FIFO：按调用顺序获得锁（不是随机唤醒）", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    const tasks = [0, 1, 2, 3].map((index) =>
      mutex.runExclusive(async () => {
        await delay(2);
        order.push(index);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("⑥ 两个独立实例互不阻塞（可并行）", async () => {
    const firstMutex = new AsyncMutex();
    const secondMutex = new AsyncMutex();
    const events: string[] = [];

    const first = firstMutex.runExclusive(async () => {
      events.push("first-enter");
      await delay(20);
      events.push("first-exit");
    });
    const second = secondMutex.runExclusive(async () => {
      events.push("second-enter");
      await delay(20);
      events.push("second-exit");
    });
    await Promise.all([first, second]);

    /** 两个实例各自独立 ⇒ 两个 enter 都在任何 exit 之前。 */
    expect(events.slice(0, 2).sort()).toEqual(["first-enter", "second-enter"]);
  });

  it("⑦ 已知限制被记录：同一实例在临界区内再次加锁会互相等待（不静默放行）", async () => {
    const mutex = new AsyncMutex();
    const nested = mutex.runExclusive(async () => {
      /** 内层必须在 50ms 内拿不到锁（否则说明锁没有生效）。 */
      const inner = mutex.runExclusive(async () => "inner");
      const raced = await Promise.race([inner.then(() => "acquired"), delay(50).then(() => "blocked")]);
      return raced;
    });
    expect(await nested).toBe("blocked");
  });
});
