/**
 * 回访账本跨实例并发（2026-11-18）。
 *
 * 账本记录"谁在什么任务下回访过什么、用掉多少预算"：丢记录 ⇒ 预算可被绕过、
 * 同一请求可被重复放行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileContextRecallLedgerStore } from "../../../packages/core/src/orchestration/context-recall-ledger-store.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "recall-ledger-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): FileContextRecallLedgerStore {
  return new FileContextRecallLedgerStore({
    baseDirectory: stateDirectory,
    callerAgentInstanceId: "agent-1",
  });
}

describe("回访账本跨实例并发", () => {
  it("① 两个实例并发写入 40 个账本键 ⇒ 40 条全部可见", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const writes: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      writes.push(
        firstStore.writeEntry(`ledger-a-${String(index)}`, {
          ledgerKey: `ledger-a-${String(index)}`,
          taskExecutionId: "task-exec:agent-1",
          contextNodeIdentifier: "node-1",
          sourceRevision: 1,
          injectedTokenCount: 10,
          recordedAtIso: "2026-11-18T00:00:00.000Z",
        } as never),
        secondStore.writeEntry(`ledger-b-${String(index)}`, {
          ledgerKey: `ledger-b-${String(index)}`,
          taskExecutionId: "task-exec:agent-1",
          contextNodeIdentifier: "node-2",
          sourceRevision: 1,
          injectedTokenCount: 10,
          recordedAtIso: "2026-11-18T00:00:00.000Z",
        } as never),
      );
    }
    await Promise.all(writes);

    const document = JSON.parse(
      await fs.readFile(
        path.join(stateDirectory, "agent-memory", "agent-1", "recall-ledger.json"),
        "utf8",
      ),
    ) as { entriesByLedgerKey: Record<string, unknown> };
    expect(Object.keys(document.entriesByLedgerKey)).toHaveLength(40);
  }, 90_000);
});
