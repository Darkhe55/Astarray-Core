/**
 * COMM-01 重放去重的持久化（2026-11-14，用户裁决第 2 条）。
 *
 * 核心断言：**重启后同一条消息仍然是重复**（内存去重做不到这点），
 * 且重复时返回**首次结果**并带次数；存档损坏时**拒绝**而不是静默当新消息。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommDeliveredMessageStore } from "../../../packages/core/src/orchestration/comm-delivered-message-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "comm-delivered-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("重放去重持久化", () => {
  it("① 首次投递 ⇒ 非重复、次数 1，并落盘可查", async () => {
    const store = new CommDeliveredMessageStore({ baseDirectory });
    const outcome = await store.recordDelivery({
      messageIdentifier: "message-1",
      incomingResult: { answer: "首次" },
      deliveredAtIso: "2026-11-14T00:00:00.000Z",
    });

    expect(outcome.isDuplicate).toBe(false);
    expect(outcome.occurrenceCount).toBe(1);
    const record = await store.findDelivered("message-1");
    expect(record?.occurrenceCount).toBe(1);
    expect(record?.originalResult).toEqual({ answer: "首次" });
  });

  it("② 同进程重复投递 ⇒ 静默去重、返回首次结果、次数 2", async () => {
    const store = new CommDeliveredMessageStore({ baseDirectory });
    await store.recordDelivery({
      messageIdentifier: "message-1",
      incomingResult: "首次结果",
      deliveredAtIso: "2026-11-14T00:00:00.000Z",
    });
    const second = await store.recordDelivery({
      messageIdentifier: "message-1",
      incomingResult: "第二次结果（不得覆盖）",
      deliveredAtIso: "2026-11-14T00:00:05.000Z",
    });

    expect(second.isDuplicate).toBe(true);
    expect(second.result).toBe("首次结果");
    expect(second.occurrenceCount).toBe(2);
  });

  it("③ **重启后**（新实例）同一条消息仍是重复 ⇒ 不会重复副作用", async () => {
    const firstStore = new CommDeliveredMessageStore({ baseDirectory });
    await firstStore.recordDelivery({
      messageIdentifier: "message-restart",
      incomingResult: "重启前的结果",
      deliveredAtIso: "2026-11-14T00:00:00.000Z",
    });

    /** 模拟服务重启：全新实例，只共享磁盘。 */
    const restartedStore = new CommDeliveredMessageStore({ baseDirectory });
    const afterRestart = await restartedStore.recordDelivery({
      messageIdentifier: "message-restart",
      incomingResult: "重启后的重复投递",
      deliveredAtIso: "2026-11-14T01:00:00.000Z",
    });

    expect(afterRestart.isDuplicate).toBe(true);
    expect(afterRestart.result).toBe("重启前的结果");
    expect(afterRestart.occurrenceCount).toBe(2);
  });

  it("④ 不同消息标识互不影响（不得因去重而串档）", async () => {
    const store = new CommDeliveredMessageStore({ baseDirectory });
    await store.recordDelivery({
      messageIdentifier: "message-a",
      incomingResult: "A 的结果",
      deliveredAtIso: "2026-11-14T00:00:00.000Z",
    });
    const other = await store.recordDelivery({
      messageIdentifier: "message-b",
      incomingResult: "B 的结果",
      deliveredAtIso: "2026-11-14T00:00:01.000Z",
    });

    expect(other.isDuplicate).toBe(false);
    expect(other.result).toBe("B 的结果");
    expect(await store.findDelivered("message-a")).not.toBeNull();
    expect(await store.findDelivered("message-b")).not.toBeNull();
  });

  it("⑤ 存档损坏 ⇒ **拒绝**记录（不得把已投递消息当新消息再执行）", async () => {
    const store = new CommDeliveredMessageStore({ baseDirectory });
    const directory = path.join(baseDirectory, "comm-delivered-messages");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "delivered.json"), '{"records":42}', "utf8");

    const readResult = await store.read();
    expect(readResult.isHistoryTrustworthy).toBe(false);
    await expect(
      store.recordDelivery({
        messageIdentifier: "message-1",
        incomingResult: "结果",
        deliveredAtIso: "2026-11-14T00:00:00.000Z",
      }),
    ).rejects.toThrow(/存档损坏/u);
  });

  it("⑥ 次数如实累加到 3（重复次数不是布尔标记）", async () => {
    const store = new CommDeliveredMessageStore({ baseDirectory });
    for (const deliveredAtIso of [
      "2026-11-14T00:00:00.000Z",
      "2026-11-14T00:00:01.000Z",
      "2026-11-14T00:00:02.000Z",
    ]) {
      await store.recordDelivery({
        messageIdentifier: "message-1",
        incomingResult: "结果",
        deliveredAtIso,
      });
    }
    expect((await store.findDelivered("message-1"))?.occurrenceCount).toBe(3);
  });
});
