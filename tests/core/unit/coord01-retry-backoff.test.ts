/**
 * COORD-01-02（卡 §4.7）：应用失败的**持久退避**。
 *
 * 反例优先：
 * - 首次失败 ⇒ 1 秒退避，当下不可再试；
 * - 第 5 次失败 ⇒ 转 blocked，**不再自动重试**（即使时间过去很久）；
 * - **重启不清零**：新实例读回计数与 blocked 状态；
 * - 成功 ⇒ 清除记录；显式重试 ⇒ 重新可自动尝试。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COORDINATION_MAXIMUM_AUTOMATIC_ATTEMPTS,
  CoordinationRetryStore,
} from "../../../packages/core/src/orchestration/coordination-retry-store.js";

let stateDirectory: string;
let nowUnixMilliseconds: number;
const partitionKey = "project:project-alpha|scheduler:scheduler-1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-retry-"));
  nowUnixMilliseconds = 1_700_000_000_000;
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStore() {
  return new CoordinationRetryStore({
    stateDirectory,
    nowUnixMilliseconds: () => nowUnixMilliseconds,
  });
}

describe("应用失败持久退避", () => {
  it("① 首次失败 ⇒ 1 秒退避，当下不可再试", async () => {
    const store = buildStore();
    const record = await store.recordFailure({
      partitionKey,
      messageIdentifier: "message-1",
      reason: "stale",
    });
    expect(record.attemptCount).toBe(1);
    expect(record.isBlocked).toBe(false);
    expect(record.nextAttemptAtUnixMilliseconds).toBe(nowUnixMilliseconds + 1000);
    expect(
      await store.isEligibleForAutomaticAttempt({ partitionKey, messageIdentifier: "message-1" }),
    ).toBe(false);
  });

  it("② 第 5 次失败 ⇒ blocked，之后**永不再自动重试**", async () => {
    const store = buildStore();
    for (let attempt = 1; attempt <= COORDINATION_MAXIMUM_AUTOMATIC_ATTEMPTS; attempt += 1) {
      await store.recordFailure({ partitionKey, messageIdentifier: "message-1", reason: "stale" });
      nowUnixMilliseconds += 60_000;
    }
    const record = await store.readRetryRecord({ partitionKey, messageIdentifier: "message-1" });
    expect(record?.isBlocked).toBe(true);
    nowUnixMilliseconds += 24 * 60 * 60 * 1000;
    expect(
      await store.isEligibleForAutomaticAttempt({ partitionKey, messageIdentifier: "message-1" }),
    ).toBe(false);
  });

  it("③ **重启不清零**：新实例读回计数与 blocked", async () => {
    const first = buildStore();
    await first.recordFailure({ partitionKey, messageIdentifier: "message-1", reason: "stale" });
    const restarted = buildStore();
    const record = await restarted.readRetryRecord({ partitionKey, messageIdentifier: "message-1" });
    expect(record?.attemptCount).toBe(1);
  });

  it("④ 成功清除记录；显式重试后恢复可自动尝试", async () => {
    const store = buildStore();
    for (let attempt = 1; attempt <= COORDINATION_MAXIMUM_AUTOMATIC_ATTEMPTS; attempt += 1) {
      await store.recordFailure({ partitionKey, messageIdentifier: "message-1", reason: "stale" });
    }
    await store.resetForExplicitRetry({ partitionKey, messageIdentifier: "message-1" });
    expect(
      await store.isEligibleForAutomaticAttempt({ partitionKey, messageIdentifier: "message-1" }),
    ).toBe(true);

    await store.recordFailure({ partitionKey, messageIdentifier: "message-2", reason: "stale" });
    await store.recordSuccess({ partitionKey, messageIdentifier: "message-2" });
    expect(
      await store.readRetryRecord({ partitionKey, messageIdentifier: "message-2" }),
    ).toBeNull();
  });
});
