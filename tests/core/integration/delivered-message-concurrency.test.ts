/**
 * 投递记录跨实例并发（2026-11-18）。
 *
 * 投递记录是"这条消息已经处理过"的去重依据：丢记录 ⇒ 同一条消息被**重复执行**。
 * 两个独立实例并发登记不同消息，读-改-写必须串行化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommDeliveredMessageStore } from "../../../packages/core/src/orchestration/comm-delivered-message-store.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "delivered-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): CommDeliveredMessageStore {
  return new CommDeliveredMessageStore({ baseDirectory: stateDirectory });
}

describe("投递记录跨实例并发", () => {
  it("① 两个实例并发登记 40 条 ⇒ 40 条记录全部落盘", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const records: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      records.push(
        firstStore.recordDelivery({
          messageIdentifier: `message-a-${String(index)}`,
          incomingResult: "success",
          deliveredAtIso: "2026-11-18T00:00:00.000Z",
        } as never),
        secondStore.recordDelivery({
          messageIdentifier: `message-b-${String(index)}`,
          incomingResult: "success",
          deliveredAtIso: "2026-11-18T00:00:00.000Z",
        } as never),
      );
    }
    await Promise.all(records);

    const readResult = await buildStore().read();
    expect(readResult.isHistoryTrustworthy).toBe(true);
    expect(readResult.document.records).toHaveLength(40);
  }, 90_000);
});
