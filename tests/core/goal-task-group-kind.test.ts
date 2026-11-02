/**
 * R62（2026-10-30）：`groupKind` 默认策略的单测。
 *
 * 只测**纯函数** `resolveGoalTaskGroupKind` 的判定规则：
 * provider 优先、provider 抛错回退、返工集合命中、普通组。
 * 不测编排器接线（那需要真实调度器），也不声称"门禁/停滞行为已验证"。
 */
import { describe, expect, it } from "vitest";

import { resolveGoalTaskGroupKind } from "../../packages/core/src/orchestration/goal-task-group-kind.js";

describe("resolveGoalTaskGroupKind", () => {
  it("未提供 provider：任务都不在返工集合 ⇒ normal", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: ["task-1", "task-2"],
      reworkedTaskIdentifiers: new Set<string>(),
    });
    expect(resolved).toBe("normal");
  });

  it("未提供 provider：任一任务在返工集合 ⇒ rework", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: ["task-1", "task-2"],
      reworkedTaskIdentifiers: new Set<string>(["task-2"]),
    });
    expect(resolved).toBe("rework");
  });

  it("提供 provider：以 provider 结果为准（覆盖返工事实）", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: ["task-1"],
      reworkedTaskIdentifiers: new Set<string>(["task-1"]),
      provider: () => "investigation",
    });
    expect(resolved).toBe("investigation");
  });

  it("provider 抛错：回退 normal（诊断失败不改变停顿语义）", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: ["task-1"],
      reworkedTaskIdentifiers: new Set<string>(["task-1"]),
      provider: () => {
        throw new Error("provider 故障");
      },
    });
    expect(resolved).toBe("normal");
  });

  it("空任务组 ⇒ normal（不产生 investigation）", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: [],
      reworkedTaskIdentifiers: new Set<string>(),
    });
    expect(resolved).toBe("normal");
  });

  it("R141：全部启动任务都是只读调查组 ⇒ investigation", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: ["task-1", "task-2"],
      reworkedTaskIdentifiers: new Set<string>(),
      investigationTaskIdentifiers: new Set<string>(["task-1", "task-2"]),
    });
    expect(resolved).toBe("investigation");
  });

  it("R141：调查组与返工同时命中 ⇒ rework 优先（返工语义更强）", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: ["task-1"],
      reworkedTaskIdentifiers: new Set<string>(["task-1"]),
      investigationTaskIdentifiers: new Set<string>(["task-1"]),
    });
    expect(resolved).toBe("rework");
  });

  it("R141：只有部分任务只读 ⇒ normal（不把写组伪装成调查）", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: ["task-1", "task-2"],
      reworkedTaskIdentifiers: new Set<string>(),
      investigationTaskIdentifiers: new Set<string>(["task-1"]),
    });
    expect(resolved).toBe("normal");
  });

  it("传给 provider 的是任务标识副本（外部修改不影响判定）", () => {
    const taskIdentifiers = ["task-1"];
    let received: readonly string[] = [];
    resolveGoalTaskGroupKind({
      taskIdentifiers,
      reworkedTaskIdentifiers: new Set<string>(),
      provider: (input) => {
        received = input.taskIdentifiers;
        return "normal";
      },
    });
    expect(received).toEqual(["task-1"]);
    expect(received).not.toBe(taskIdentifiers);
  });
});

describe("调查组局部信号（R141）", () => {
  it("只读工具判定与整组判定", async () => {
    const { isReadOnlyToolName, isInvestigationTaskGroup } = await import(
      "../../packages/core/src/orchestration/goal-investigation-signal.js"
    );
    expect(isReadOnlyToolName("readFile")).toBe(true);
    expect(isReadOnlyToolName("searchProjectText")).toBe(true);
    expect(isReadOnlyToolName("createProjectFile")).toBe(false);
    expect(isReadOnlyToolName("unknown-tool")).toBe(false);
    expect(
      isInvestigationTaskGroup({ taskToolNames: [["readFile"], ["searchProjectText"]] }),
    ).toBe(true);
    expect(
      isInvestigationTaskGroup({ taskToolNames: [["readFile", "createProjectFile"]] }),
    ).toBe(false);
    expect(isInvestigationTaskGroup({ taskToolNames: [[]] })).toBe(false);
  });
});
