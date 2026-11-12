/**
 * 完成收据存储（此前 `tests/` 零引用）：**收据是证据，不能被事后改写**。
 *
 * 反例优先：不足的收据拒绝落盘且不留文件；同内容幂等；不同内容拒绝覆盖；
 * 损坏文件读回 null 且不掺入列表。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompletionReceiptStore } from "../../../packages/core/src/orchestration/completion-receipt-store.js";
import type { CompletionReceipt } from "../../../packages/core/src/orchestration/completion-receipt.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-store-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildReceipt(overrides: Partial<CompletionReceipt> = {}): CompletionReceipt {
  return {
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    hasVerifiedCompletionControlEvent: true,
    toolCallCount: 2,
    artifactPaths: ["src/a.ts"],
    recordedAtIso: "2026-11-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("完成收据存储", () => {
  it("① 不足的收据 ⇒ 拒绝落盘且不留文件", async () => {
    const store = new CompletionReceiptStore({ baseDirectory });
    await expect(store.save(buildReceipt({ toolCallCount: -1 }))).rejects.toThrow(/拒绝落盘/u);
    expect(await store.listForMission("mission-1")).toEqual([]);
    expect(await store.read("mission-1", "T-001")).toBeNull();
  });

  it("② 缺任务标识 ⇒ 拒绝", async () => {
    const store = new CompletionReceiptStore({ baseDirectory });
    await expect(store.save(buildReceipt({ taskIdentifier: "  " }))).rejects.toThrow();
    expect(await store.listForMission("mission-1")).toEqual([]);
  });

  it("③ 首次写入 ⇒ didWrite=true，可读回", async () => {
    const store = new CompletionReceiptStore({ baseDirectory });
    expect((await store.save(buildReceipt())).didWrite).toBe(true);
    expect(await store.read("mission-1", "T-001")).toEqual(buildReceipt());
  });

  it("④ 同内容重复写入 ⇒ 幂等（didWrite=false）", async () => {
    const store = new CompletionReceiptStore({ baseDirectory });
    await store.save(buildReceipt());
    expect((await store.save(buildReceipt())).didWrite).toBe(false);
  });

  it("⑤ 不同内容 ⇒ journal-corrupted，原收据保持不变", async () => {
    const store = new CompletionReceiptStore({ baseDirectory });
    await store.save(buildReceipt());
    await expect(
      store.save(buildReceipt({ toolCallCount: 9 })),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
    expect((await store.read("mission-1", "T-001"))?.toolCallCount).toBe(2);
  });

  it("⑥ listForMission 按 task 排序；损坏文件跳过；未知 mission ⇒ 空", async () => {
    const store = new CompletionReceiptStore({ baseDirectory });
    await store.save(buildReceipt({ taskIdentifier: "T-002" }));
    await store.save(buildReceipt({ taskIdentifier: "T-001" }));
    expect((await store.listForMission("mission-1")).map((receipt) => receipt.taskIdentifier)).toEqual([
      "T-001",
      "T-002",
    ]);

    const missionDirectory = path.join(baseDirectory, "completion-receipts", "mission-1");
    await fs.writeFile(path.join(missionDirectory, "T-009.json"), '{"schemaVersion":2}', "utf8");
    expect(await store.read("mission-1", "T-009")).toBeNull();
    expect((await store.listForMission("mission-1")).map((receipt) => receipt.taskIdentifier)).toEqual([
      "T-001",
      "T-002",
    ]);
    expect(await store.listForMission("mission-unknown")).toEqual([]);
  });
});
