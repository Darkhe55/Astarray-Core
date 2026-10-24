/** 上下文包（2026-10-24）：校验 + 装配整体性。 */
import { describe, expect, it } from "vitest";

import {
  assertContextPackValid,
  renderContextPacks,
  validateContextPack,
  type ContextPack,
} from "../../../packages/core/src/orchestration/context-pack.js";
import { assembleContextPrompt } from "../../../packages/core/src/orchestration/context-prompt-assembler.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { TaskSequenceManageController, TaskSequenceStatusController } from "../../../packages/core/src/orchestration/task-sequence-controllers.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const atomicPack: ContextPack = {
  packIdentifier: "pack-atomic",
  mergePolicy: "atomic",
  sourcePriority: "user",
  members: [
    { memberIdentifier: "m1", sourceKind: "user", summary: "用户约束：不得改公共契约" },
    { memberIdentifier: "m2", sourceKind: "evidence", summary: "证据：接口快照 v3" },
  ],
};

describe("上下文包（任务序列持久化）", () => {
  it("④ 插入任务时声明的 contextPack 持久化并可读回", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-context-pack-"));
    try {
      const store = new AgentTaskSequenceStore({ baseDirectory });
      const manage = new TaskSequenceManageController(store);
      const actor = { sourceKind: "user" as const, actorId: "user-1" };
      await manage.publishSequence({
        ownerAgentInstanceId: "agent-1",
        actor,
        sequenceId: "seq-1",
        firstTask: { taskId: "t1", title: "首任务", priorityTier: 0, externalReference: null },
      });
      await manage.insertTask({
        ownerAgentInstanceId: "agent-1",
        actor,
        sequenceId: "seq-1",
        expectedRevision: 2,
        task: { taskId: "t2", title: "带上下文包", priorityTier: 0, externalReference: null, contextPack: atomicPack },
        anchor: { predecessorTaskIds: ["t1"], successorTaskIds: [] },
      });
      const snapshot = await new TaskSequenceStatusController(store).getSnapshot({
        ownerAgentInstanceId: "agent-1",
        sequenceId: "seq-1",
        viewer: actor,
      });
      const inserted = snapshot.nodes.find((node) => node.taskId === "t2");
      expect(inserted?.contextPack?.packIdentifier).toBe("pack-atomic");
    } finally {
      await rm(baseDirectory, { recursive: true, force: true });
    }
  });
});

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


