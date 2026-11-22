/**
 * COORD-05 05-05（2026-11-22）：**调度闸门**——依赖决定的节点在决定写回前不可运行。
 *
 * 覆盖：无证据不可运行、写回证据（来自任务链）放行、运行时 markDecisionApplied 放行、
 * 下游节点仍受普通依赖约束、无决定依赖的节点不受影响。
 */
import { describe, expect, it } from "vitest";

import { TaskGraph } from "../../../packages/core/src/core/task-graph.js";
import type { TaskChainDocument, TaskDependencyNode } from "../../../packages/core/src/core/types.js";

function node(overrides: Partial<TaskDependencyNode> = {}): TaskDependencyNode {
  return {
    id: "step-export",
    description: "导出",
    dependsOn: [],
    taskType: "data",
    toolNames: ["readFile"],
    assignedAgentId: "w1",
    status: "pending",
    resultLocation: null,
    ...overrides,
  };
}

function chain(
  tasks: TaskDependencyNode[],
  decisionIdentifiers: string[] = [],
): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "m-1",
    revision: 1,
    updatedAtIso: "2026-11-22T00:00:00.000Z",
    tasks,
    ...(decisionIdentifiers.length === 0
      ? {}
      : {
          decisionApplicationEvidence: decisionIdentifiers.map((decisionIdentifier) => ({
            decisionIdentifier,
            escalationRequestIdentifier: "escalation-1",
            source: "user" as const,
            summary: "采用方案 A",
            affectedStepIdentifiers: ["step-export"],
            appliedAtIso: "2026-11-22T00:00:00.000Z",
          })),
        }),
  };
}

describe("COORD-05：依赖决定的调度闸门", () => {
  it("① 无写回证据 ⇒ 依赖决定的节点不可运行；无依赖节点正常", () => {
    const graph = TaskGraph.fromTaskChain(
      chain([
        node({ dependsOnDecisionIdentifiers: ["decision-1"] }),
        node({ id: "step-free" }),
      ]),
    );
    expect(graph.findRunnableTaskIds()).toEqual(["step-free"]);
  });

  it("② 任务链已有写回证据 ⇒ 节点可运行", () => {
    const graph = TaskGraph.fromTaskChain(
      chain(
        [node({ dependsOnDecisionIdentifiers: ["decision-1"] })],
        ["decision-1"],
      ),
    );
    expect(graph.findRunnableTaskIds()).toEqual(["step-export"]);
  });

  it("③ 运行时 markDecisionApplied ⇒ 下一轮调度放行", () => {
    const graph = TaskGraph.fromTaskChain(
      chain([node({ dependsOnDecisionIdentifiers: ["decision-1"] })]),
    );
    expect(graph.findRunnableTaskIds()).toEqual([]);
    graph.markDecisionApplied("decision-1");
    expect(graph.findRunnableTaskIds()).toEqual(["step-export"]);
  });

  it("④ 下游节点仍受普通依赖约束（上游未完成 ⇒ 下游不运行）", () => {
    const graph = TaskGraph.fromTaskChain(
      chain(
        [
          node({ dependsOnDecisionIdentifiers: ["decision-1"] }),
          node({ id: "step-after", dependsOn: ["step-export"] }),
        ],
        ["decision-1"],
      ),
    );
    expect(graph.findRunnableTaskIds()).toEqual(["step-export"]);
  });

  it("⑤ 只写回部分依赖 ⇒ 仍等待；全部写回 ⇒ 放行", () => {
    const graph = TaskGraph.fromTaskChain(
      chain(
        [
          node({
            dependsOnDecisionIdentifiers: ["decision-1", "decision-2"],
          }),
        ],
        ["decision-1"],
      ),
    );
    expect(graph.findRunnableTaskIds()).toEqual([]);
    graph.markDecisionApplied("decision-2");
    expect(graph.findRunnableTaskIds()).toEqual(["step-export"]);
  });
});
