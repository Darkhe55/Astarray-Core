/** 上下文包（2026-10-24）：校验 + 装配整体性。 */
import { describe, expect, it } from "vitest";

import {
  assertContextPackValid,
  renderContextPacks,
  validateContextPack,
  type ContextPack,
} from "../../../packages/core/src/orchestration/context-pack.js";
import { assembleContextPrompt } from "../../../packages/core/src/orchestration/context-prompt-assembler.js";

const atomicPack: ContextPack = {
  packIdentifier: "pack-atomic",
  mergePolicy: "atomic",
  sourcePriority: "user",
  members: [
    { memberIdentifier: "m1", sourceKind: "user", summary: "用户约束：不得改公共契约" },
    { memberIdentifier: "m2", sourceKind: "evidence", summary: "证据：接口快照 v3" },
  ],
};

describe("上下文包", () => {
  it("① 合法包：atomic 成员成组渲染，且标识被记录", () => {
    expect(validateContextPack(atomicPack)).toEqual([]);
    const rendered = renderContextPacks([atomicPack]);
    expect(rendered.injectedPackIdentifiers).toEqual(["pack-atomic"]);
    expect(rendered.lines.join("\n")).toContain("atomic：整包注入，不拆分");
    expect(rendered.lines.join("\n")).toContain("证据：接口快照 v3");
  });

  it("② 空包 / 重复成员 / 未知来源 ⇒ 拒绝（不静默降级）", () => {
    const empty = { ...atomicPack, members: [] };
    expect(validateContextPack(empty).length).toBeGreaterThan(0);
    expect(() => assertContextPackValid(empty)).toThrow(/context-pack-invalid|至少需要一个成员/);

    const duplicated: ContextPack = {
      ...atomicPack,
      members: [
        { memberIdentifier: "m1", sourceKind: "user", summary: "A" },
        { memberIdentifier: "m1", sourceKind: "evidence", summary: "B" },
      ],
    };
    expect(validateContextPack(duplicated).join("；")).toContain("成员标识重复");

    const badSource: ContextPack = {
      ...atomicPack,
      members: [{ memberIdentifier: "m1", sourceKind: "unknown" as never, summary: "x" }],
    };
    expect(validateContextPack(badSource).join("；")).toContain("成员来源未知");
  });

  it("③ 装配器：separate 包各自独立，atomic 包整包注入", () => {
    const separatePack: ContextPack = {
      packIdentifier: "pack-separate",
      mergePolicy: "separate",
      sourcePriority: "agent",
      members: [{ memberIdentifier: "a1", sourceKind: "agent", summary: "Agent 笔记 A" }],
    };
    const assembled = assembleContextPrompt({
      systemRulesText: "规则",
      necessaryConditions: [],
      globalDecisionRecords: [],
      activeFrontier: null,
      contextPacks: [atomicPack, separatePack],
    });
    expect(assembled.injectedContextPackIdentifiers).toEqual([
      "pack-atomic",
      "pack-separate",
    ]);
    const text = assembled.promptText;
    expect(text).toContain("atomic：整包注入，不拆分");
    expect(text).toContain("separate：独立成组，不与其他包合并");
    expect(text.indexOf("pack-atomic")).toBeLessThan(text.indexOf("pack-separate"));
  });
});

