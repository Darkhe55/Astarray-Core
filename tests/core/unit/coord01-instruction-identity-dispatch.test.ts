/**
 * COORD-01-03 §3：派发时**沿用上游稳定身份**。
 *
 * 直接调用 `MainController.sendSchedulerInstruction`，用记录型传输观察实际入队参数：
 * - 传同一 `stableMessageIdentifier` 两次 ⇒ 两次入队的 `messageId` 与 `idempotencyKey` **完全相同**
 *   （journal 侧据此去重，重投不会产生第二条）；
 * - 不传 ⇒ 两次身份**不同**（保持既有行为，不误合并）。
 */
import { describe, expect, it } from "vitest";

import { MainController } from "../../../packages/core/src/orchestration/main-controller.js";

interface RecordedEnqueue {
  messageId: string;
  idempotencyKey: string;
  payload: unknown;
}

function buildController(recorded: RecordedEnqueue[]) {
  const feedbackTransport = {
    enqueue: async (message: never) => {
      const typed = message as unknown as RecordedEnqueue;
      recorded.push(typed);
      return 0;
    },
  };
  const controller = new MainController({
    feedbackTransport,
    mode: "assist",
  } as never);
  return controller;
}

describe("派发沿用稳定身份", () => {
  it("① 同一 stableMessageIdentifier ⇒ 两次入队身份相同", () => {
    const recorded: RecordedEnqueue[] = [];
    const controller = buildController(recorded);
    controller.sendSchedulerInstruction("mission-1", "继续", "stable-1");
    controller.sendSchedulerInstruction("mission-1", "继续", "stable-1");
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.messageId).toBe(recorded[1]?.messageId);
    expect(recorded[0]?.idempotencyKey).toBe(recorded[1]?.idempotencyKey);
  });

  it("② 不传稳定标识 ⇒ 两次身份不同（不误合并）", () => {
    const recorded: RecordedEnqueue[] = [];
    const controller = buildController(recorded);
    controller.sendSchedulerInstruction("mission-1", "继续");
    controller.sendSchedulerInstruction("mission-1", "继续");
    expect(recorded[0]?.messageId).not.toBe(recorded[1]?.messageId);
  });
});
