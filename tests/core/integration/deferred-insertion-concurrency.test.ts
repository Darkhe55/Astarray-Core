/**
 * 推迟插入队列跨实例并发（2026-11-18）。
 *
 * 队列是"组关闭时先排着、安全点再插入"的待办：丢条目 ⇒ 该任务**永远不会被插入**。
 * 两个独立实例并发入队，读-改-写必须串行化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeferredInsertionQueueStore } from "../../../packages/core/src/orchestration/deferred-insertion-queue.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "deferred-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildQueue(): DeferredInsertionQueueStore {
  return new DeferredInsertionQueueStore({ baseDirectory: stateDirectory });
}

function buildEntry(sequence: number) {
  return {
    insertRequestIdentifier: `request-${String(sequence)}`,
    missionIdentifier: "mission-1",
    taskIdentifier: `T-${String(sequence)}`,
    sequenceIdentifier: "sequence-1",
    deferredAtIso: "2026-11-18T00:00:00.000Z",
  } as never;
}

describe("推迟插入队列跨实例并发", () => {
  it("① 两个实例并发入队 40 条 ⇒ 40 条全部在队列里", async () => {
    const firstQueue = buildQueue();
    const secondQueue = buildQueue();
    const enqueues: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      enqueues.push(
        firstQueue.enqueue(buildEntry(index * 2)),
        secondQueue.enqueue(buildEntry(index * 2 + 1)),
      );
    }
    await Promise.all(enqueues);

    const pending = await buildQueue().listPending();
    expect(pending).toHaveLength(40);
  }, 90_000);

  it("② 并发入队 + 并发消费不互相覆盖（消费后仍能看到剩余条目）", async () => {
    const firstQueue = buildQueue();
    const secondQueue = buildQueue();
    await Promise.all([
      firstQueue.enqueue(buildEntry(1)),
      secondQueue.enqueue(buildEntry(2)),
      firstQueue.enqueue(buildEntry(3)),
    ]);
    await Promise.all([
      firstQueue.markConsumed({
        insertRequestIdentifier: "request-1",
        consumedAtIso: "2026-11-18T00:00:01.000Z",
        consumedByGroupIdentifier: "group-1",
      }),
      secondQueue.markConsumed({
        insertRequestIdentifier: "request-2",
        consumedAtIso: "2026-11-18T00:00:01.000Z",
        consumedByGroupIdentifier: "group-1",
      }),
    ]);
    const pending = await buildQueue().listPending();
    expect(pending.map((entry: { insertRequestIdentifier: string }) => entry.insertRequestIdentifier)).toEqual(["request-3"]);
  }, 90_000);
});
