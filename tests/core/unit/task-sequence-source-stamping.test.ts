/**
 * WIRING-04-04（方案 A）：候选稿声明的来源如何变成**权威来源三元组**。
 *
 * 原则：候选稿只能声明"我来自哪条用户任务"；序列标识与属主由装配层补齐。
 * 声明与权威任务不一致 ⇒ **剥离并报告**（不采信、不猜测）。
 */
import { describe, expect, it } from "vitest";

import { stampDeclaredSequenceSources } from "../../../packages/core/src/orchestration/task-sequence-source-stamping.js";
import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";

function buildNode(overrides: Partial<TaskDependencyNode> = {}): TaskDependencyNode {
  return {
    id: "T-1",
    description: "执行",
    dependsOn: [],
    taskType: "data",
    toolNames: [],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
    ...overrides,
  };
}

const context = {
  originalTaskIdentifier: "task-mission-1",
  sequenceIdentifier: "sequence-agent-1",
  ownerAgentInstanceIdentifier: "agent-1",
};

describe("WIRING-04-04：声明来源的采信规则", () => {
  it("① 声明与权威任务一致 ⇒ 补齐三元组并报告可绑定", async () => {
    const result = stampDeclaredSequenceSources({
      nodes: [buildNode({ sourceSequenceTaskIdentifier: "task-mission-1" })],
      ...context,
    });
    expect(result.stampedMissionTaskIdentifiers).toEqual(["T-1"]);
    expect(result.nodes[0]).toMatchObject({
      sourceSequenceTaskIdentifier: "task-mission-1",
      sourceSequenceIdentifier: "sequence-agent-1",
      sourceSequenceOwnerAgentInstanceIdentifier: "agent-1",
    });
  }, 30_000);

  it("② 声明与权威任务不一致 ⇒ 剥离并报告（不采信）", async () => {
    const result = stampDeclaredSequenceSources({
      nodes: [buildNode({ sourceSequenceTaskIdentifier: "task-other" })],
      ...context,
    });
    expect(result.stampedMissionTaskIdentifiers).toEqual([]);
    expect(result.rejectedMissionTaskIdentifiers).toEqual(["T-1"]);
    expect(result.nodes[0]?.sourceSequenceTaskIdentifier).toBeUndefined();
  }, 30_000);

  it("③ 缺少权威上下文 ⇒ 一律剥离（无法补齐就不假装有来源）", async () => {
    const result = stampDeclaredSequenceSources({
      nodes: [buildNode({ sourceSequenceTaskIdentifier: "task-mission-1" })],
      originalTaskIdentifier: null,
      sequenceIdentifier: null,
      ownerAgentInstanceIdentifier: null,
    });
    expect(result.stampedMissionTaskIdentifiers).toEqual([]);
    expect(result.rejectedMissionTaskIdentifiers).toEqual(["T-1"]);
    expect(result.nodes[0]?.sourceSequenceTaskIdentifier).toBeUndefined();
  }, 30_000);

  it("④ 未声明来源的节点保持原样（不强行补）", async () => {
    const result = stampDeclaredSequenceSources({
      nodes: [buildNode(), buildNode({ id: "T-2" })],
      ...context,
    });
    expect(result.stampedMissionTaskIdentifiers).toEqual([]);
    expect(result.rejectedMissionTaskIdentifiers).toEqual([]);
    expect(result.nodes[1]?.sourceSequenceIdentifier).toBeUndefined();
  }, 30_000);
});
