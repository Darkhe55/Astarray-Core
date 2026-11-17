/**
 * COORD-03（2026-11-17 用户裁决）：上下文包装配策略与关闭节点回访策略。
 *
 * 反例覆盖裁决逐条要求：依赖包不自动继承、版本固定、冲突处理、超预算、
 * 跨个体隔离、已关闭节点按需读取，以及"读取不触发续跑"。
 */
import { describe, expect, it } from "vitest";

import {
  planContextPackAssembly,
  type DependencyPackReference,
} from "../../../packages/core/src/orchestration/context-pack-assembly.js";
import type { ContextPack } from "../../../packages/core/src/orchestration/context-pack.js";
import {
  buildClosedNodeRecallCandidateIndex,
  evaluateClosedNodeRecall,
  selectAutomaticRecallCandidates,
} from "../../../packages/core/src/orchestration/closed-node-recall-policy.js";

const AGENT = "agent-worker-1";

function buildPack(input: {
  packIdentifier: string;
  members: ReadonlyArray<{ identifier: string; summary: string; fingerprint?: string }>;
  mergePolicy?: "atomic" | "summarize-allowed" | "separate";
  sourceKind?: "user" | "agent" | "tool" | "decision";
  sourcePriority?: "user" | "agent" | "tool";
}): ContextPack {
  return {
    packIdentifier: input.packIdentifier,
    mergePolicy: input.mergePolicy ?? "summarize-allowed",
    sourcePriority: input.sourcePriority ?? "agent",
    members: input.members.map((member) => ({
      memberIdentifier: member.identifier,
      sourceKind: input.sourceKind ?? "agent",
      summary: member.summary,
      ...(member.fingerprint === undefined ? {} : { contentFingerprint: member.fingerprint }),
    })),
  };
}

function buildReference(overrides: Partial<DependencyPackReference> = {}): DependencyPackReference {
  return {
    taskIdentifier: "T-DEP",
    packIdentifier: "pack-dep",
    pinnedRevision: 3,
    currentRevision: 3,
    ownerAgentInstanceIdentifier: AGENT,
    pack: buildPack({
      packIdentifier: "pack-dep",
      members: [{ identifier: "fact-1", summary: "依赖事实" }],
    }),
    ...overrides,
  };
}

describe("上下文包装配（用户裁决逐条）", () => {
  it("① 依赖包不自动继承：未显式引用 ⇒ 不包含", () => {
    const plan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: null },
      dependencyReferences: [],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 10_000,
    });
    expect(plan.includedPacks).toHaveLength(0);
    expect(plan.dedupedMembers).toHaveLength(0);
  });

  it("② 版本固定：引用 revision 与当前不一致 ⇒ 排除（不按最新版兜底）", () => {
    const plan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: null },
      dependencyReferences: [buildReference({ pinnedRevision: 3, currentRevision: 4 })],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 10_000,
    });
    expect(plan.includedPacks).toHaveLength(0);
    expect(plan.excludedReferences[0]?.reason).toContain("引用版本已过期");
  });

  it("③ 重复内容去重但保留来源", () => {
    const duplicatePack = buildPack({
      packIdentifier: "pack-dep",
      members: [{ identifier: "fact-1", summary: "依赖事实", fingerprint: "fp-1" }],
    });
    const currentPack = buildPack({
      packIdentifier: "pack-current",
      members: [{ identifier: "fact-1", summary: "依赖事实", fingerprint: "fp-1" }],
    });
    const plan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: currentPack },
      dependencyReferences: [buildReference({ pack: duplicatePack })],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 10_000,
    });
    expect(plan.dedupedMembers).toHaveLength(1);
    expect(plan.dedupedMembers[0]?.provenances).toEqual([
      "current-task:T-1",
      "dependency-reference:T-DEP",
    ]);
  });

  it("④ 指令冲突按发布权限裁决（user > agent），不按包位置", () => {
    const currentPack = buildPack({
      packIdentifier: "pack-current",
      members: [{ identifier: "rule-1", summary: "执行 A" }],
      sourceKind: "decision",
      sourcePriority: "agent",
    });
    const dependencyPack = buildPack({
      packIdentifier: "pack-dep",
      members: [{ identifier: "rule-1", summary: "执行 B" }],
      sourceKind: "decision",
      sourcePriority: "user",
    });
    const plan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: currentPack },
      dependencyReferences: [buildReference({ pack: dependencyPack })],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 10_000,
    });
    expect(plan.conflicts[0]).toMatchObject({
      kind: "instruction",
      resolvedSourceKind: "user",
    });
    expect(plan.escalations).toHaveLength(0);
  });

  it("⑤ 事实冲突 ⇒ 提交直属上级裁决（不静默覆盖）", () => {
    const currentPack = buildPack({
      packIdentifier: "pack-current",
      members: [{ identifier: "fact-9", summary: "数值 1" }],
    });
    const dependencyPack = buildPack({
      packIdentifier: "pack-dep",
      members: [{ identifier: "fact-9", summary: "数值 2" }],
    });
    const plan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: currentPack },
      dependencyReferences: [buildReference({ pack: dependencyPack })],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 10_000,
    });
    expect(plan.conflicts[0]).toMatchObject({ kind: "fact", resolvedSourceKind: null });
    expect(plan.escalations).toHaveLength(1);
  });

  it("⑥ 超预算：普通包 ⇒ requires-split；atomic 包 ⇒ blocked（都不截断）", () => {
    const bigPack = buildPack({
      packIdentifier: "pack-dep",
      members: [{ identifier: "big-1", summary: "x".repeat(200) }],
    });
    const splitPlan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: null },
      dependencyReferences: [buildReference({ pack: bigPack })],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 50,
    });
    expect(splitPlan.budget.kind).toBe("requires-split");

    const atomicPack = buildPack({
      packIdentifier: "pack-dep",
      mergePolicy: "atomic",
      members: [{ identifier: "big-1", summary: "x".repeat(200) }],
    });
    const blockedPlan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: null },
      dependencyReferences: [buildReference({ pack: atomicPack })],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 50,
    });
    expect(blockedPlan.budget.kind).toBe("blocked");
  });

  it("⑦ 跨个体隔离：不属于当前个体的包不得继承", () => {
    const plan = planContextPackAssembly({
      currentTask: { taskIdentifier: "T-1", pack: null },
      dependencyReferences: [buildReference({ ownerAgentInstanceIdentifier: "agent-other" })],
      currentAgentInstanceIdentifier: AGENT,
      maximumCharacterCount: 10_000,
    });
    expect(plan.includedPacks).toHaveLength(0);
    expect(plan.excludedReferences[0]?.reason).toContain("跨个体隔离");
  });
});

describe("关闭节点回访（用户裁决逐条）", () => {
  it("⑧ 自动相关性召回恒为空（首版不引入向量/自动决策）", () => {
    expect(selectAutomaticRecallCandidates()).toEqual([]);
  });

  it("⑨ 按需回访只接受显式引用命中；依赖关系候选不算", () => {
    const candidates = buildClosedNodeRecallCandidateIndex({
      dependencyRelations: [{ contextNodeIdentifier: "node-1", sourceRevision: 2 }],
    });
    const decision = evaluateClosedNodeRecall({
      requestKind: "on-demand",
      request: { contextNodeIdentifier: "node-1", sourceRevision: 2 },
      candidates,
      isAuthorized: true,
    });
    expect(decision.isAllowed).toBe(false);
    expect(decision.reason).toContain("显式引用");
  });

  it("⑩ 预声明依赖可在授权下读取固定 revision", () => {
    const candidates = buildClosedNodeRecallCandidateIndex({
      dependencyRelations: [{ contextNodeIdentifier: "node-2", sourceRevision: 5 }],
    });
    const allowed = evaluateClosedNodeRecall({
      requestKind: "pre-declared-dependency",
      request: { contextNodeIdentifier: "node-2", sourceRevision: 5 },
      candidates,
      isAuthorized: true,
    });
    expect(allowed.isAllowed).toBe(true);

    const wrongRevision = evaluateClosedNodeRecall({
      requestKind: "pre-declared-dependency",
      request: { contextNodeIdentifier: "node-2", sourceRevision: 6 },
      candidates,
      isAuthorized: true,
    });
    expect(wrongRevision.isAllowed).toBe(false);
  });

  it("⑪ 无授权 ⇒ 拒绝（不因节点已关闭而放宽）", () => {
    const candidates = buildClosedNodeRecallCandidateIndex({
      explicitReferences: [{ contextNodeIdentifier: "node-3", sourceRevision: 1 }],
    });
    const decision = evaluateClosedNodeRecall({
      requestKind: "on-demand",
      request: { contextNodeIdentifier: "node-3", sourceRevision: 1 },
      candidates,
      isAuthorized: false,
    });
    expect(decision.isAllowed).toBe(false);
  });

  it("⑫ 回访不重开节点、不恢复任务、不改历史", () => {
    const candidates = buildClosedNodeRecallCandidateIndex({
      explicitReferences: [{ contextNodeIdentifier: "node-4", sourceRevision: 1 }],
    });
    const decision = evaluateClosedNodeRecall({
      requestKind: "on-demand",
      request: { contextNodeIdentifier: "node-4", sourceRevision: 1 },
      candidates,
      isAuthorized: true,
    });
    expect(decision.isAllowed).toBe(true);
    expect(decision.sideEffects).toEqual({
      reopensNode: false,
      resumesTask: false,
      mutatesHistory: false,
    });
  });
});
