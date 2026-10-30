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

  it("默认策略永不产生 investigation（无返工信号时）", () => {
    const resolved = resolveGoalTaskGroupKind({
      taskIdentifiers: [],
      reworkedTaskIdentifiers: new Set<string>(),
    });
    expect(resolved).not.toBe("investigation");
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
