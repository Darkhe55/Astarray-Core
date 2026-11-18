/**
 * 台账跨实例并发（2026-11-18）：**并发记录不能丢条目**。
 *
 * 台账是"待办清单"：漏记一条就等于崩溃后不再补做。两个独立实例
 * （模拟两个进程）同时记录不同消息，读-改-写必须串行化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoordinationTaskApplicationLedger } from "../../../packages/core/src/orchestration/coordination-task-application-ledger.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildLedger(): CoordinationTaskApplicationLedger {
  return new CoordinationTaskApplicationLedger({
    baseDirectory: stateDirectory,
    nowIso: () => "2026-11-18T00:00:00.000Z",
  });
}

describe("台账跨实例并发", () => {
  it("① 两个实例并发记录 40 条不同消息 ⇒ 40 条全部落盘", async () => {
    const firstLedger = buildLedger();
    const secondLedger = buildLedger();

    const records: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      const firstMessage = `message-a-${String(index)}`;
      const secondMessage = `message-b-${String(index)}`;
      records.push(
        firstLedger.recordIntent({
          messageIdentifier: firstMessage,
          missionIdentifier: "mission-1",
          taskIdentifier: "T-001",
        }),
        secondLedger.recordIntent({
          messageIdentifier: secondMessage,
          missionIdentifier: "mission-1",
          taskIdentifier: "T-001",
        }),
      );
    }
    await Promise.all(records);

    const entries = await buildLedger().readAll();
    expect(entries.size).toBe(40);
    /** 每一条都必须是 pending（尚未完成），不能凭空变成别的状态。 */
    expect([...entries.values()].every((entry) => entry.status === "pending")).toBe(true);
  }, 90_000);

  it("② 同一消息被两个实例并发记录 ⇒ 只有一条，且状态一致", async () => {
    const firstLedger = buildLedger();
    const secondLedger = buildLedger();
    await Promise.all([
      firstLedger.recordIntent({
        messageIdentifier: "message-1",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-001",
      }),
      secondLedger.recordIntent({
        messageIdentifier: "message-1",
        missionIdentifier: "mission-1",
        taskIdentifier: "T-001",
      }),
    ]);
    const entries = await buildLedger().readAll();
    expect(entries.size).toBe(1);
  }, 60_000);
});
