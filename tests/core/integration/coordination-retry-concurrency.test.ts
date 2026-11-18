/**
 * 协调重试记录跨实例并发（2026-11-18）。
 *
 * 重试记录决定"这条消息还能自动重试几次、下次何时可试"：丢记录 ⇒
 * 自动重试上限失效（无限重试）或退避被重置。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoordinationRetryStore } from "../../../packages/core/src/orchestration/coordination-retry-store.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "retry-store-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): CoordinationRetryStore {
  return new CoordinationRetryStore({
    stateDirectory,
    nowUnixMilliseconds: () => Date.parse("2026-11-18T00:00:00.000Z"),
  } as never);
}

describe("协调重试记录跨实例并发", () => {
  it("① 两个实例并发记录 40 条失败 ⇒ 40 条全部落盘", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const failures: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      failures.push(
        firstStore.recordFailure({
          partitionKey: "partition-1",
          messageIdentifier: `message-a-${String(index)}`,
          reason: "传输失败",
        }),
        secondStore.recordFailure({
          partitionKey: "partition-1",
          messageIdentifier: `message-b-${String(index)}`,
          reason: "传输失败",
        }),
      );
    }
    await Promise.all(failures);

    const document = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "partition-1.json"), "utf8"),
    ) as { records: Array<unknown> };
    expect(document.records).toHaveLength(40);
  }, 90_000);

  it("② 同一消息并发记录两次失败 ⇒ 计数为 2（不丢一次尝试）", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    await Promise.all([
      firstStore.recordFailure({
        partitionKey: "partition-2",
        messageIdentifier: "message-1",
        reason: "传输失败",
      }),
      secondStore.recordFailure({
        partitionKey: "partition-2",
        messageIdentifier: "message-1",
        reason: "传输失败",
      }),
    ]);
    const document = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "partition-2.json"), "utf8"),
    ) as { records: Array<{ messageIdentifier: string; attemptCount: number }> };
    const record = document.records.find((entry) => entry.messageIdentifier === "message-1");
    expect(record?.attemptCount).toBe(2);
  }, 90_000);
});
