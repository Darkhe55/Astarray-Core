/**
 * WIRING-04 §36.3 反例：完成收据的**不可变首次创建**（2026-11-18）。
 *
 * 收据是完成证明：同一 mission/task 只允许一份，内容不同必须拒绝覆盖。
 * 两个独立实例并发写入**不同内容**时，必须恰好一个成功、另一个拿到明确拒绝，
 * 磁盘上留着胜出者的内容（不允许静默覆盖）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionReceiptStore } from "../../../packages/core/src/orchestration/completion-receipt-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-immutable-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): CompletionReceiptStore {
  return new CompletionReceiptStore({ baseDirectory: stateDirectory });
}

function buildReceipt(toolCallCount: number, artifactPath: string) {
  return {
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    toolCallCount,
    artifactPaths: [artifactPath],
    hasVerifiedCompletionControlEvent: true,
    claimedStatus: "complete",
    taskSequenceRevision: 1,
  } as never;
}

describe("WIRING-04 §36.3：完成收据的不可变首次创建", () => {
  it("① 两个实例并发写入不同内容 ⇒ 只有一个落盘，另一个被明确拒绝", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const results = await Promise.allSettled([
      firstStore.save(buildReceipt(1, "out/a.md")),
      secondStore.save(buildReceipt(2, "out/b.md")),
    ]);

    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect((rejection.reason as { errorCode?: string }).errorCode).toBe("journal-corrupted");

    /** 磁盘上是胜出者；另一份没有被静默写入。 */
    const stored = await buildStore().read("mission-1", "T-001");
    const isFirstWin =
      stored !== null &&
      (stored as unknown as { toolCallCount: number }).toolCallCount === 1 &&
      (stored as unknown as { artifactPaths: string[] }).artifactPaths[0] === "out/a.md";
    const isSecondWin =
      stored !== null &&
      (stored as unknown as { toolCallCount: number }).toolCallCount === 2 &&
      (stored as unknown as { artifactPaths: string[] }).artifactPaths[0] === "out/b.md";
    expect(isFirstWin || isSecondWin).toBe(true);
  }, 60_000);

  it("② 同内容重复写入 ⇒ 幂等（didWrite=false），不报错", async () => {
    const store = buildStore();
    const first = await store.save(buildReceipt(1, "out/a.md"));
    const second = await buildStore().save(buildReceipt(1, "out/a.md"));
    expect(first.didWrite).toBe(true);
    expect(second.didWrite).toBe(false);
  }, 60_000);
});
