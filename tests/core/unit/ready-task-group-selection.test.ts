/**
 * ALIGN-02-03（2026-11-05）：ready set 工作单元选择。
 *
 * 覆盖：未满足依赖永不入选、用户/Agent 跨层排序、必要前驱提升、
 * 包整体推迟（不拆包）、预算按单元计。
 */
import { describe, expect, it } from "vitest";

import { selectReadyTaskUnits } from "../../../packages/core/src/orchestration/ready-task-group-selection.js";
import type { AgentTaskNode, TaskBundleRecord } from "../../../packages/core/src/core/types.js";

function makeNode(input: {
  taskId: string;
  priorityTier: number;
  dependsOn?: string[];
  status?: AgentTaskNode["status"];
  sequenceOrdinal: number;
}): AgentTaskNode {
  return {
    taskId: input.taskId,
    title: `任务 ${input.taskId}`,
    dependsOn: input.dependsOn ?? [],
    sourceKind: "user",
    publisherId: "user-1",
    priorityTier: input.priorityTier,
    status: input.status ?? "pending",
    blockReason: null,
    externalReference: null,
    sequenceOrdinal: input.sequenceOrdinal,
    createdAtIso: new Date().toISOString(),
  };
}

function makeBundle(input: {
  bundleId: string;
  taskIds: string[];
  status?: TaskBundleRecord["status"];
}): TaskBundleRecord {
  return {
    bundleId: input.bundleId,
    boundAgentInstanceId: "agent-tertiary-1",
    sequenceRevision: 1,
    taskIds: input.taskIds,
    status: input.status ?? "prepared",
    createdAtIso: new Date().toISOString(),
  };
}

describe("ready set 工作单元选择", () => {
  it("依赖未满足的任务永远不入选（即使层级更高）", () => {
    const selection = selectReadyTaskUnits({
      nodes: [
        makeNode({ taskId: "T-blocked", priorityTier: 0, dependsOn: ["T-pred"], sequenceOrdinal: 0 }),
        makeNode({ taskId: "T-pred", priorityTier: 1, sequenceOrdinal: 1 }),
        makeNode({ taskId: "T-free", priorityTier: 1, sequenceOrdinal: 2 }),
      ],
      bundles: [],
      maximumUnitCount: 5,
    });
    expect(selection.readyTaskIdentifiers).toEqual(["T-pred", "T-free"]);
    expect(selection.units.map((unit) => unit.unitIdentifier)).toEqual([
      "T-pred",
      "T-free",
    ]);
  });

  it("用户层（0）排在 Agent 层（1）之前；必要前驱随后继提升", () => {
    const selection = selectReadyTaskUnits({
      nodes: [
        /** P 是 H（用户层）的必要前驱：有效优先级取 min(1,0)=0。 */
        makeNode({ taskId: "P", priorityTier: 1, sequenceOrdinal: 1 }),
        makeNode({ taskId: "H", priorityTier: 0, dependsOn: ["P"], sequenceOrdinal: 2 }),
        makeNode({ taskId: "A", priorityTier: 1, sequenceOrdinal: 0 }),
      ],
      bundles: [],
      maximumUnitCount: 5,
    });
    /** P 未完成 ⇒ H 不在 ready，但 P 的有效优先级被后继拉高。 */
    expect(selection.effectivePriorityTierByTaskIdentifier["P"]).toBe(0);
    expect(selection.units.map((unit) => unit.unitIdentifier)).toEqual(["P", "A"]);
  });

  it("包内存在非 pending 任务 ⇒ 整包推迟（不拆包）", () => {
    const selection = selectReadyTaskUnits({
      nodes: [
        makeNode({ taskId: "T-1", priorityTier: 1, sequenceOrdinal: 1 }),
        makeNode({
          taskId: "T-2",
          priorityTier: 1,
          dependsOn: ["T-1"],
          status: "running",
          sequenceOrdinal: 2,
        }),
      ],
      bundles: [makeBundle({ bundleId: "bundle-1", taskIds: ["T-1", "T-2"] })],
      maximumUnitCount: 5,
    });
    expect(selection.units).toHaveLength(0);
    expect(selection.deferredReasons["bundle-1"]).toContain("非 pending");
  });

  it("预算按单元计：装不下的单元整体推迟，包不截断", () => {
    const selection = selectReadyTaskUnits({
      nodes: [
        makeNode({ taskId: "T-1", priorityTier: 0, sequenceOrdinal: 1 }),
        makeNode({ taskId: "T-2", priorityTier: 1, sequenceOrdinal: 2 }),
      ],
      bundles: [makeBundle({ bundleId: "bundle-1", taskIds: ["T-1", "T-2"] })],
      maximumUnitCount: 1,
    });
    expect(selection.units).toHaveLength(1);
    expect(selection.units[0]?.unitKind).toBe("bundle");
    expect(selection.units[0]?.taskIdentifiers).toEqual(["T-1", "T-2"]);
    expect(selection.units[0]?.taskIdentifiers).toHaveLength(2);
  });

  it("预算为 0 拒绝（不静默按 1 处理）", () => {
    expect(() =>
      selectReadyTaskUnits({ nodes: [], bundles: [], maximumUnitCount: 0 }),
    ).toThrow(/预算必须是 ≥1 的整数/u);
  });
});
