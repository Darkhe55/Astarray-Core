/**
 * 结构化回访账本（此前 `tests/` 零引用）：跨进程回执冷却与任务级预算的持久化。
 *
 * 反例优先：未写入 ⇒ null / 0（不伪造）；不同调用者**严格隔离**；
 * 调用者 ID 里的路径分隔符不得逃出 base 目录；文档损坏读作空；重复写入覆盖为最新。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileContextRecallLedgerStore } from "../../../packages/core/src/orchestration/context-recall-ledger-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "recall-ledger-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildStore(callerAgentInstanceId = "agent-1") {
  return new FileContextRecallLedgerStore({ baseDirectory, callerAgentInstanceId });
}

describe("回访账本持久化", () => {
  it("① 未写入 ⇒ null / 0（不伪造历史）", async () => {
    const store = buildStore();
    expect(await store.readEntry("ledger-key-1")).toBeNull();
    expect(await store.readTaskRecallCount("task-execution-1")).toBe(0);
  });

  it("② 写入后可读回；entry 与 count 互不影响", async () => {
    const store = buildStore();
    await store.writeEntry("ledger-key-1", { returnedAtMilliseconds: 1_700_000_000_000, tier: "node-index" });
    await store.writeTaskRecallCount("task-execution-1", 2);

    expect(await store.readEntry("ledger-key-1")).toEqual({
      returnedAtMilliseconds: 1_700_000_000_000,
      tier: "node-index",
    });
    expect(await store.readTaskRecallCount("task-execution-1")).toBe(2);
    /** 写 count 不应清掉 entry。 */
    await store.writeTaskRecallCount("task-execution-1", 3);
    expect(await store.readEntry("ledger-key-1")).not.toBeNull();
  });

  it("③ 不同调用者严格隔离（同一 base 下互不可见）", async () => {
    const first = buildStore("agent-1");
    const second = buildStore("agent-2");
    await first.writeEntry("ledger-key-1", { returnedAtMilliseconds: 1, tier: "closure-capsule" });
    await first.writeTaskRecallCount("task-execution-1", 5);

    expect(await second.readEntry("ledger-key-1")).toBeNull();
    expect(await second.readTaskRecallCount("task-execution-1")).toBe(0);
  });

  it("④ 调用者 ID 含路径分隔符也不得逃出 base 目录", async () => {
    const store = buildStore("../../escape-attempt");
    await store.writeTaskRecallCount("task-execution-1", 4);

    const escapedPath = path.join(baseDirectory, "..", "escape-attempt");
    const escapedExists = await fs
      .stat(escapedPath)
      .then(() => true)
      .catch(() => false);
    expect(escapedExists).toBe(false);

    /** 账本仍落在 base 下的 agent-memory 里，且能读回。 */
    expect(await store.readTaskRecallCount("task-execution-1")).toBe(4);
  });

  it("⑤ 文档损坏 ⇒ 读作空文档（不抛错、不伪造）", async () => {
    const store = buildStore("agent-broken");
    const ledgerPath = path.join(baseDirectory, "agent-memory", "agent-broken", "recall-ledger.json");
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, JSON.stringify({ entriesByLedgerKey: "not-an-object" }), "utf8");

    expect(await store.readEntry("ledger-key-1")).toBeNull();
    expect(await store.readTaskRecallCount("task-execution-1")).toBe(0);
  });

  it("⑥ 重复写入同一 key ⇒ 覆盖为最新（账本记录最近一次，不堆积历史）", async () => {
    const store = buildStore();
    await store.writeEntry("ledger-key-1", { returnedAtMilliseconds: 1, tier: "node-index" });
    await store.writeEntry("ledger-key-1", { returnedAtMilliseconds: 2, tier: "selected-evidence" });
    expect(await store.readEntry("ledger-key-1")).toEqual({
      returnedAtMilliseconds: 2,
      tier: "selected-evidence",
    });
  });
});
