/**
 * ALIGN-04-05（2026-11-10）：**回访内容注入提示词装配**。
 *
 * 卡内缺口："未注入提示词装配（组装上下文时不会自动回访，只能由上层显式调用）"。
 *
 * 本文件钉住装配侧的注入契约：
 *  ① 缺省**不注入**（旧行为不变）；
 *  ② 注入时必须带**节点标识 + revision**，无来源的文本一律不注入；
 *  ③ 必须显式声明"这是该节点关闭摘要，不是完整历史"。
 *
 * 注意：**自动触发**（装配时自己去回访）仍未接线 —— 本文件只覆盖注入面。
 */
import { describe, expect, it, vi } from "vitest";

import { assembleContextPrompt } from "../../../packages/core/src/orchestration/context-prompt-assembler.js";

vi.setConfig({ testTimeout: 30_000 });

function assemble(extra: Record<string, unknown> = {}) {
  return assembleContextPrompt({
    systemRulesText: "系统规则",
    necessaryConditions: [],
    globalDecisionRecords: [],
    activeFrontier: null,
    ...extra,
  } as never);
}

describe("ALIGN-04-05 回访内容注入", () => {
  it("缺省不注入该区块（旧行为不变）", () => {
    const assembled = assemble();
    expect(assembled.promptText).not.toContain("[按节点回访的已关闭上下文]");
    expect(assembled.injectedRecalledContextNodeIdentifiers).toEqual([]);
  });

  it("给出回访块 ⇒ 注入，并带回节点标识与 revision", () => {
    const assembled = assemble({
      recalledContextBlocks: [
        { contextNodeIdentifier: "node-1", sourceRevision: 3, text: "该节点结论摘要" },
      ],
    });
    expect(assembled.promptText).toContain("[按节点回访的已关闭上下文]");
    expect(assembled.promptText).toContain("node-1");
    expect(assembled.promptText).toContain("revision 3");
    expect(assembled.promptText).toContain("该节点结论摘要");
    expect(assembled.injectedRecalledContextNodeIdentifiers).toEqual(["node-1"]);
  });

  it("**声明边界**：明确写出「不是完整历史」", () => {
    const assembled = assemble({
      recalledContextBlocks: [
        { contextNodeIdentifier: "node-1", sourceRevision: 1, text: "摘要" },
      ],
    });
    expect(assembled.promptText).toContain("不是完整历史");
    expect(assembled.promptText).toContain("不含其他节点内容");
  });

  it("无节点标识或无正文 ⇒ 不注入（不得凭无来源文本当历史）", () => {
    const assembled = assemble({
      recalledContextBlocks: [
        { contextNodeIdentifier: "  ", sourceRevision: 1, text: "摘要" },
        { contextNodeIdentifier: "node-2", sourceRevision: 1, text: "   " },
      ],
    });
    expect(assembled.promptText).not.toContain("[按节点回访的已关闭上下文]");
    expect(assembled.injectedRecalledContextNodeIdentifiers).toEqual([]);
  });

  it("多个块 ⇒ 逐个列出，全部记录注入标识", () => {
    const assembled = assemble({
      recalledContextBlocks: [
        { contextNodeIdentifier: "node-1", sourceRevision: 1, text: "A" },
        { contextNodeIdentifier: "node-2", sourceRevision: 2, text: "B" },
      ],
    });
    expect(assembled.injectedRecalledContextNodeIdentifiers).toEqual(["node-1", "node-2"]);
  });
});
