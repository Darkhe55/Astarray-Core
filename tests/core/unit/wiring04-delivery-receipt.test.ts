/**
 * WIRING-04-02 补口（2026-11-25）：投递回执顺序的反例。
 *
 * 历史缺陷：先写 delivered 回执、再投递 ⇒ 中间崩溃会丢消息（记为已投递却从未送达）。
 * 这里钉住：**投递成功才写回执**；投递失败不写；回执失败向上抛（消息已送达，可能重投，靠接收端去重）。
 */
import { describe, expect, it } from "vitest";

import { deliverThenRecordReceipt } from "../../../packages/core/src/feedback-process/delivery-receipt.js";

describe("WIRING-04-02 投递回执顺序", () => {
  it("① 先投递、后写回执（顺序可观测）", async () => {
    const order: string[] = [];
    await deliverThenRecordReceipt({
      dispatch: () => order.push("dispatch"),
      recordReceipt: async () => {
        order.push("receipt");
        await Promise.resolve();
      },
    });
    expect(order).toEqual(["dispatch", "receipt"]);
  });

  it("② 投递失败 ⇒ 不写回执、错误上抛（消息保持未投递，可重试）", async () => {
    let receiptWritten = false;
    await expect(
      deliverThenRecordReceipt({
        dispatch: () => {
          throw new Error("IPC channel closed");
        },
        recordReceipt: async () => {
          receiptWritten = true;
        },
      }),
    ).rejects.toThrow("IPC channel closed");
    expect(receiptWritten).toBe(false);
  });

  it("③ 回执失败 ⇒ 错误上抛（不静默当作已投递）", async () => {
    let dispatched = false;
    await expect(
      deliverThenRecordReceipt({
        dispatch: () => {
          dispatched = true;
        },
        recordReceipt: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(dispatched).toBe(true);
  });

  it("④ 成功路径只写一次回执（不逐事件重复写）", async () => {
    let receiptCount = 0;
    await deliverThenRecordReceipt({
      dispatch: () => undefined,
      recordReceipt: async () => {
        receiptCount += 1;
      },
    });
    expect(receiptCount).toBe(1);
  });
});
