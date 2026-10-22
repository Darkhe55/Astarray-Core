/**
 * SMART-01 右键菜单反例（2026-10-22）：指令窗口状态放在右键 Agent 菜单里。
 *
 * 覆盖：区块挂在指定 agent、显示各条指令入口、区分"已接收/已处理"、
 * 超时与积压如实提示、积压时禁用批量提交、任何菜单项都不代替用户自动提交、不改会话状态。
 */
import { describe, expect, it } from "vitest";

import {
  buildInstructionWindowMenuSection,
  type InstructionWindowMenuState,
} from "../../../packages/core/src/orchestration/instruction-window-menu.js";

function state(overrides: Partial<InstructionWindowMenuState> = {}): InstructionWindowMenuState {
  return {
    pendingInstructionCount: 2,
    windowCapacity: 3,
    timedOutInstructionCount: 0,
    hasProcessedInstruction: false,
    isQueueBacklogged: false,
    ...overrides,
  };
}

function build(overrides: Partial<InstructionWindowMenuState> = {}) {
  return buildInstructionWindowMenuSection({ agentInstanceId: "agent-1", state: state(overrides) });
}

describe("SMART-01 右键 Agent 菜单中的指令窗口", () => {
  it("① 区块挂在被右键的 agent 上，且不改变会话状态", () => {
    const section = build();
    expect(section.agentInstanceId).toBe("agent-1");
    expect(section.sectionIdentifier).toBe("instruction-window");
    expect(section.changesSessionState).toBe(false);
  });

  it("② 显示各条指令的入口始终可用", () => {
    const section = build({ pendingInstructionCount: 0 });
    const viewItem = section.items.find((item) => item.itemIdentifier === "view-instructions");
    expect(viewItem?.isEnabled).toBe(true);
  });

  it("③ 状态文案区分「已接收」与「主模型已处理」", () => {
    const received = build();
    expect(received.statusText).toContain("已接收 2 条");
    expect(received.statusText).toContain("尚未有主模型处理");

    const processed = build({ hasProcessedInstruction: true });
    expect(processed.statusText).toContain("主模型已处理");
    expect(processed.statusText).toContain("区分于已接收");
  });

  it("④ 有超时 ⇒ 如实写「超时未达标 N 条」（不粉饰）", () => {
    const section = build({ timedOutInstructionCount: 1 });
    expect(section.statusText).toContain("超时未达标 1 条");
  });

  it("⑤ 积压 ⇒ 提示窗口已满，并禁用批量提交（可拆分/取消/调容量）", () => {
    const section = build({ isQueueBacklogged: true });
    expect(section.statusText).toContain("窗口已满");
    const batchSubmit = section.items.find((item) => item.itemIdentifier === "batch-submit");
    expect(batchSubmit?.isEnabled).toBe(false);
    const split = section.items.find((item) => item.itemIdentifier === "split-instruction");
    const cancel = section.items.find((item) => item.itemIdentifier === "cancel-instruction");
    const capacity = section.items.find((item) => item.itemIdentifier === "change-window-capacity");
    expect(split?.isEnabled).toBe(true);
    expect(cancel?.isEnabled).toBe(true);
    expect(capacity?.isEnabled).toBe(true);
  });

  it("⑥ 没有待处理指令 ⇒ 拆分/批量/取消都不可用（避免空操作）", () => {
    const section = build({ pendingInstructionCount: 0 });
    for (const identifier of ["split-instruction", "batch-submit", "cancel-instruction"]) {
      const item = section.items.find((candidate) => candidate.itemIdentifier === identifier);
      expect(item?.isEnabled).toBe(false);
    }
  });

  it("⑦ 任何菜单项都**不代替用户自动提交**", () => {
    const section = build();
    expect(section.items.every((item) => item.isAutomaticOnBehalfOfUser === false)).toBe(true);
  });
});
