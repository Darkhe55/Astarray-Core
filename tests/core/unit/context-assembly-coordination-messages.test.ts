/**
 * COMM-01「迟到/乱序」装配调用点（2026-11-14，用户裁决第 3 条）。
 *
 * 用户口径：同一 agent 会收到分属**不同任务意图**的消息序列，序列可能被其它内容打断；
 * 做法是**上下文装配时区分开**，只有确实同属一个事实的内容才能合在一起送给模型。
 *
 * 本文件把该口径钉在真正的装配入口（`assembleContextPrompt`）上：
 * - 未给出协调消息 ⇒ 提示词**与旧行为一致**（不注入空区块）；
 * - 给出时按"同任务 + 同序列"分块，未确认同一事实的消息**单列**、不并入合并块。
 */
import { describe, expect, it } from "vitest";

import { assembleContextPrompt } from "../../../packages/core/src/orchestration/context-prompt-assembler.js";

function buildBaseInput() {
  return {
    systemRulesText: "只做被要求的事",
    necessaryConditions: [],
    globalDecisionRecords: [],
    activeFrontier: null,
  };
}

describe("上下文装配：协调消息分区", () => {
  it("① 未提供协调消息 ⇒ 不注入该区块（旧行为不变）", () => {
    const assembled = assembleContextPrompt({ ...buildBaseInput() });
    expect(assembled.promptText).not.toContain("[协调消息]");
    expect(assembled.injectedCoordinationMessageIdentifiers ?? []).toEqual([]);
  });

  it("② 同任务同序列被打断也聚合；不同任务分开渲染", () => {
    const assembled = assembleContextPrompt({
      ...buildBaseInput(),
      coordinationMessages: [
        {
          messageIdentifier: "m1",
          sourceTaskIdentifier: "task-a",
          sequenceIdentifier: "seq-a",
          isSameFactAsSequence: true,
          text: "A 任务第一条",
        },
        {
          messageIdentifier: "m2",
          sourceTaskIdentifier: "task-b",
          sequenceIdentifier: "seq-b",
          isSameFactAsSequence: true,
          text: "B 任务第一条",
        },
        {
          messageIdentifier: "m3",
          sourceTaskIdentifier: "task-a",
          sequenceIdentifier: "seq-a",
          isSameFactAsSequence: true,
          text: "A 任务第二条",
        },
      ],
    });

    expect(assembled.promptText).toContain("[协调消息]");
    const blockA = assembled.promptText.indexOf("A 任务第一条");
    const blockB = assembled.promptText.indexOf("B 任务第一条");
    const blockA2 = assembled.promptText.indexOf("A 任务第二条");
    expect(blockA).toBeGreaterThanOrEqual(0);
    expect(blockB).toBeGreaterThanOrEqual(0);
    expect(blockA2).toBeGreaterThan(blockA);
    /**
     * 分块渲染顺序 = **每组首条消息的到达顺序**（不是逐条交错）。
     * 用户口径只要求"装配时区分开、同事实才合并"，未要求交错渲染；
     * 关键断言在：A 的两条同块相邻、B 独立成块、三者都被注入。
     */
    expect(assembled.injectedCoordinationMessageIdentifiers).toEqual(["m1", "m3", "m2"]);
  });

  it("③ 未确认同一事实 ⇒ 单独列出，不并入合并块", () => {
    const assembled = assembleContextPrompt({
      ...buildBaseInput(),
      coordinationMessages: [
        {
          messageIdentifier: "m1",
          sourceTaskIdentifier: "task-a",
          sequenceIdentifier: "seq-a",
          isSameFactAsSequence: true,
          text: "已确认事实",
        },
        {
          messageIdentifier: "m9",
          sourceTaskIdentifier: "task-a",
          sequenceIdentifier: "seq-a",
          isSameFactAsSequence: false,
          text: "尚未确认是否同一事实",
        },
      ],
    });

    expect(assembled.promptText).toContain("尚未确认是否同一事实");
    expect(assembled.unmergedCoordinationMessageIdentifiers).toEqual(["m9"]);
    /** 未确认内容必须与已确认块分开表述，不能混进同一条目。 */
    expect(assembled.promptText).toContain("[未确认同一事实]");
    expect(assembled.injectedCoordinationMessageIdentifiers).toEqual(["m1"]);
  });
});
