/**
 * B9（2026-11-25）：推迟插入队列（校验、幂等、冲突、消费与有界丢弃）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DeferredInsertionQueueStore } from "../../../packages/core/src/orchestration/deferred-insertion-queue.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-deferred-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function entry(overrides: Record<string, unknown> = {}) {
  return {
    insertRequestIdentifier: "insert-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-1",
    sequenceIdentifier: "seq-1",
    ownerAgentInstanceIdentifier: "agent-1",
    reason: "非安全点",
    enqueuedAtIso: "2026-11-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("B9：推迟插入队列", () => {
  it("① 缺请求标识/mission/task ⇒ invalid-task-chain（不落队列）", async () => {
    const store = new DeferredInsertionQueueStore({ baseDirectory });
    for (const blank of [
      entry({ insertRequestIdentifier: "   " }),
      entry({ missionIdentifier: "" }),
      entry({ taskIdentifier: "" }),
    ]) {
      await expect(store.enqueue(blank as never)).rejects.toMatchObject({
        errorCode: "invalid-task-chain",
      });
    }
    expect(await store.listPending()).toEqual([]);
  });

  it("② 同请求重复入队（同任务）⇒ 幂等 false；不同任务 ⇒ journal-corrupted", async () => {
    const store = new DeferredInsertionQueueStore({ baseDirectory });
    expect((await store.enqueue(entry() as never)).didEnqueue).toBe(true);
    expect((await store.enqueue(entry() as never)).didEnqueue).toBe(false);

    await expect(
      store.enqueue(entry({ taskIdentifier: "T-2" }) as never),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
    expect(await store.listPending()).toHaveLength(1);
  });

  it("③ listPending：可按 mission 过滤", async () => {
    const store = new DeferredInsertionQueueStore({ baseDirectory });
    await store.enqueue(entry({ insertRequestIdentifier: "i-1" }) as never);
    await store.enqueue(
      entry({ insertRequestIdentifier: "i-2", missionIdentifier: "mission-2", taskIdentifier: "T-2" }) as never,
    );
    expect(await store.listPending()).toHaveLength(2);
    expect(await store.listPending("mission-2")).toHaveLength(1);
    expect(await store.listPending("mission-missing")).toEqual([]);
  });

  it("④ markConsumed：未知请求 ⇒ didConsume=false；已知 ⇒ true 且移出 pending", async () => {
    const store = new DeferredInsertionQueueStore({ baseDirectory });
    await store.enqueue(entry() as never);

    expect(
      await store.markConsumed({
        insertRequestIdentifier: "insert-missing",
        consumedAtIso: "2026-11-25T00:01:00.000Z",
        consumedByGroupIdentifier: "group-1",
      } as never),
    ).toMatchObject({ didConsume: false });

    expect(
      await store.markConsumed({
        insertRequestIdentifier: "insert-1",
        consumedAtIso: "2026-11-25T00:01:00.000Z",
        consumedByGroupIdentifier: "group-1",
      } as never),
    ).toMatchObject({ didConsume: true });
    expect(await store.listPending()).toEqual([]);
    expect((await store.read()).consumed).toHaveLength(1);
  });

  it("⑤ 已消费历史有界：超出上限丢弃最旧并累计 droppedConsumedCount", async () => {
    const store = new DeferredInsertionQueueStore({ baseDirectory, maximumConsumedEntries: 1 });
    await store.enqueue(entry({ insertRequestIdentifier: "i-1" }) as never);
    await store.enqueue(
      entry({ insertRequestIdentifier: "i-2", taskIdentifier: "T-2" }) as never,
    );
    await store.markConsumed({
      insertRequestIdentifier: "i-1",
      consumedAtIso: "2026-11-25T00:01:00.000Z",
      consumedByGroupIdentifier: "group-1",
    } as never);
    const second = await store.markConsumed({
      insertRequestIdentifier: "i-2",
      consumedAtIso: "2026-11-25T00:02:00.000Z",
      consumedByGroupIdentifier: "group-1",
    } as never);
    expect(second.droppedCount).toBe(1);

    const document = await store.read();
    expect(document.consumed.length).toBeLessThanOrEqual(1);
    expect(document.droppedConsumedCount).toBeGreaterThanOrEqual(1);
  });
});
