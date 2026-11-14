/**
 * COMM-01 三条语义决策的判定层（2026-11-14，用户给定口径）。
 *
 * 每个用例都对应一条用户裁决或卡内明令禁止的写法：
 * 重放静默去重并记重复次数、任务回复必须走原路径（不得按通信对象猜）、
 * 上下文装配只合并"确实同一事实"的内容。
 */
import { describe, expect, it } from "vitest";

import {
  dedupeReplayedMessage,
  groupMessagesForAssembly,
  resolveTaskReplyRouting,
} from "../../../packages/core/src/orchestration/comm-message-routing-decisions.js";

describe("重放：静默去重并带重复次数", () => {
  it("① 首次投递 ⇒ isDuplicate=false，次数 1", () => {
    const { outcome } = dedupeReplayedMessage({
      messageIdentifier: "message-1",
      existingRecord: null,
      incomingResult: { answer: "首次结果" },
      deliveredAtIso: "2026-11-14T00:00:00.000Z",
    });
    expect(outcome.isDuplicate).toBe(false);
    expect(outcome.occurrenceCount).toBe(1);
    expect(outcome.result).toEqual({ answer: "首次结果" });
  });

  it("② 重复投递 ⇒ **静默**返回首次结果，次数递增（不抛错、不返回新结果）", () => {
    const { outcome, recordToStore } = dedupeReplayedMessage({
      messageIdentifier: "message-1",
      existingRecord: {
        messageIdentifier: "message-1",
        originalResult: { answer: "首次结果" },
        deliveredAtIso: "2026-11-14T00:00:00.000Z",
        occurrenceCount: 1,
      },
      incomingResult: { answer: "第二次结果（不得覆盖）" },
      deliveredAtIso: "2026-11-14T00:00:05.000Z",
    });
    expect(outcome.isDuplicate).toBe(true);
    expect(outcome.result).toEqual({ answer: "首次结果" });
    expect(outcome.occurrenceCount).toBe(2);
    expect(recordToStore.occurrenceCount).toBe(2);
  });

  it("③ 连续三次重放 ⇒ 次数如实累加为 3", () => {
    const { outcome } = dedupeReplayedMessage({
      messageIdentifier: "message-1",
      existingRecord: {
        messageIdentifier: "message-1",
        originalResult: "原结果",
        deliveredAtIso: "2026-11-14T00:00:00.000Z",
        occurrenceCount: 2,
      },
      incomingResult: "再来一次",
      deliveredAtIso: "2026-11-14T00:00:09.000Z",
    });
    expect(outcome.occurrenceCount).toBe(3);
  });

  it("④ 空消息标识 ⇒ 拒绝（没有稳定键就无法去重）", () => {
    expect(() =>
      dedupeReplayedMessage({
        messageIdentifier: "  ",
        existingRecord: null,
        incomingResult: null,
        deliveredAtIso: "2026-11-14T00:00:00.000Z",
      }),
    ).toThrow(/消息标识不能为空/u);
  });
});

describe("回复路由：走任务原路径，不按通信对象猜", () => {
  it("⑤ 任务已绑原路径 ⇒ 走绑定路径（即使当时正在用别的通信对象）", () => {
    const decision = resolveTaskReplyRouting({
      currentTaskIdentifier: "task-1",
      communicatorIdentifier: "someone-else-chat",
      boundReplyPathIdentifier: "path-from-task-1",
    });
    expect(decision).toEqual({
      kind: "route-through-bound-path",
      pathIdentifier: "path-from-task-1",
    });
  });

  it("⑥ 不在任务期间 ⇒ 拒绝（不得退回通信对象推断）", () => {
    expect(
      resolveTaskReplyRouting({
        currentTaskIdentifier: null,
        communicatorIdentifier: "chat-1",
        boundReplyPathIdentifier: "path-1",
      }).kind,
    ).toBe("refused");
  });

  it("⑦ 任务未登记原路径 ⇒ 拒绝，且原因点明「不得按通信对象回复」", () => {
    const decision = resolveTaskReplyRouting({
      currentTaskIdentifier: "task-1",
      communicatorIdentifier: "chat-1",
      boundReplyPathIdentifier: null,
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("unreachable");
    expect(decision.reason).toContain("未登记原回复路径");
  });
});

describe("上下文装配：只有同一事实才合并", () => {
  const messages = [
    {
      messageIdentifier: "m1",
      sourceTaskIdentifier: "task-a",
      sequenceIdentifier: "seq-a",
      isSameFactAsSequence: true,
      text: "A-1",
    },
    {
      messageIdentifier: "m2",
      sourceTaskIdentifier: "task-b",
      sequenceIdentifier: "seq-b",
      isSameFactAsSequence: true,
      text: "B-1",
    },
    /** 与 m1 同序列，但中间被 task-b 的消息打断（非相邻）。 */
    {
      messageIdentifier: "m3",
      sourceTaskIdentifier: "task-a",
      sequenceIdentifier: "seq-a",
      isSameFactAsSequence: true,
      text: "A-2",
    },
    /** 尚未确认同一事实 ⇒ 不得合并。 */
    {
      messageIdentifier: "m4",
      sourceTaskIdentifier: "task-a",
      sequenceIdentifier: "seq-a",
      isSameFactAsSequence: false,
      text: "A-3?",
    },
  ] as const;

  it("⑧ 同任务同序列即使被插入内容打断也聚合；不同任务分开", () => {
    const { groups } = groupMessagesForAssembly(messages);
    const groupA = groups.find((group) => group.sourceTaskIdentifier === "task-a");
    const groupB = groups.find((group) => group.sourceTaskIdentifier === "task-b");
    expect(groupA?.messageIdentifiers).toEqual(["m1", "m3"]);
    expect(groupB?.messageIdentifiers).toEqual(["m2"]);
    expect(groupA?.combinedText).toBe("A-1\nA-2");
  });

  it("⑨ 未确认同一事实 ⇒ 不并入任何组（宁可分开，不许猜合并）", () => {
    const { groups, unmergedMessageIdentifiers } = groupMessagesForAssembly(messages);
    expect(unmergedMessageIdentifiers).toEqual(["m4"]);
    for (const group of groups) {
      expect(group.messageIdentifiers).not.toContain("m4");
    }
  });
});
