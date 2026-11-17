/**
 * T09A-R1-01：上下文提示词装配（全局相关选择 + 局部活跃前沿 + 必要条件）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APPLICATION_CONTEXT_SYSTEM_RULES,
  assembleContextPrompt,
  createContextPromptProvider,
} from "../../../packages/core/src/orchestration/context-prompt-assembler.js";
import { GlobalDecisionStore } from "../../../packages/core/src/orchestration/global-decision-store.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-r1-01-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("T09A-R1-01：装配规则（纯函数）", () => {
  it("必要条件缺失会报告；系统规则始终存在；已关闭节点只计数", () => {
    const assembled = assembleContextPrompt({
      systemRulesText: APPLICATION_CONTEXT_SYSTEM_RULES,
      necessaryConditions: [
        { conditionIdentifier: "acceptance-criteria", description: "必须给出验收标准", isSatisfied: true },
        { conditionIdentifier: "predecessor-result:T-000", description: "需要前驱结果", isSatisfied: false },
      ],
      globalDecisionRecords: [],
      activeFrontier: {
        graphIdentifier: "mission-1",
        revision: 3,
        activeNodes: [
          { contextNodeIdentifier: "node-active", state: "active", contentFingerprint: "fp-1" },
        ],
        excludedClosedNodeCount: 2,
      },
    });
    expect(assembled.promptText).toContain("[系统规则]");
    expect(assembled.promptText).toContain("只执行分配的任务");
    expect(assembled.unsatisfiedNecessaryConditionIdentifiers).toEqual([
      "predecessor-result:T-000",
    ]);
    expect(assembled.injectedFrontierNodeIdentifiers).toEqual(["node-active"]);
    expect(assembled.excludedClosedNodeCount).toBe(2);
    expect(assembled.promptText).toContain("已关闭节点 2 个：只计数，不注入原文");
  });
});

describe("T09A-R1-01：真实存储装配（全局选择 + 活跃前沿）", () => {
  it("只注入相关全局记录与未关闭节点；无关记录与已关闭节点不进入提示词", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory });
    await globalDecisionStore.promoteCandidate({
      decisionSummary: "RELATED-DECISION-TEXT",
      keyRationale: "与当前任务相关",
      appliesToScope: "T-001",
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });
    await globalDecisionStore.promoteCandidate({
      decisionSummary: "UNRELATED-DECISION-TEXT",
      keyRationale: "与当前任务无关",
      appliesToScope: "T-999",
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });

    const graphStore = new LocalContextGraphStore({ baseDirectory });
    await graphStore.createGraph({
      graphIdentifier: "mission-1",
      ownerAgentInstanceId: "worker-1",
      missionId: "mission-1",
    });
    let graph = await graphStore.addNode({
      ownerAgentInstanceId: "worker-1",
      graphIdentifier: "mission-1",
      expectedGraphRevision: 1,
      contextNodeIdentifier: "node-active",
      missionId: "mission-1",
      contentFingerprint: "sha256:" + "a".repeat(64),
      state: "active",
    });
    graph = await graphStore.addNode({
      ownerAgentInstanceId: "worker-1",
      graphIdentifier: "mission-1",
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier: "node-closed",
      missionId: "mission-1",
      contentFingerprint: "sha256:" + "b".repeat(64),
      state: "locally-verified",
    });
    await graphStore.closeNode({
      ownerAgentInstanceId: "worker-1",
      graphIdentifier: "mission-1",
      expectedGraphRevision: graph.revision,
      contextNodeIdentifier: "node-closed",
      targetState: "accepted-closed",
    });

    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore,
      maximumGlobalContextTokenCount: 4096,
    });
    const assembled = await provider({
      missionId: "mission-1",
      agentInstanceId: "worker-1",
      task: { id: "T-001", description: "probe", dependsOn: [], taskType: "data", toolNames: [] } as never,
    });

    expect(assembled.promptText).toContain("RELATED-DECISION-TEXT");
    expect(assembled.promptText).not.toContain("UNRELATED-DECISION-TEXT");
    expect(assembled.injectedFrontierNodeIdentifiers).toContain("node-active");
    expect(assembled.injectedFrontierNodeIdentifiers).not.toContain("node-closed");
    expect(assembled.excludedClosedNodeCount).toBe(1);
  });

  it("必要条件不满足时报告给调用方（由 Worker 阻塞）", async () => {
    const provider = createContextPromptProvider({
      globalDecisionStore: new GlobalDecisionStore({ baseDirectory }),
      graphStore: new LocalContextGraphStore({ baseDirectory }),
      maximumGlobalContextTokenCount: 4096,
      mandatoryConditions: [
        { conditionIdentifier: "acceptance-criteria", description: "必须给出验收标准", isSatisfied: false },
      ],
    });
    const assembled = await provider({
      missionId: "mission-1",
      agentInstanceId: "worker-1",
      task: { id: "T-001", description: "probe", dependsOn: [], taskType: "data", toolNames: [] } as never,
    });
    expect(assembled.unsatisfiedNecessaryConditionIdentifiers).toEqual([
      "acceptance-criteria",
    ]);
  });
});

describe("WIRING-04-04：当前任务包按精确映射注入", () => {
  it("① 解析到包 ⇒ 提示词含成员摘要（不再只有四段）", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory });
    const graphStore = new LocalContextGraphStore({ baseDirectory });
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore,
      maximumGlobalContextTokenCount: 4096,
      contextPackResolver: async () => ({
        kind: "pack",
        revision: 7,
        contentHash: "hash",
        pack: {
          packIdentifier: "pack-1",
          mergePolicy: "summarize-allowed",
          sourcePriority: "agent",
          members: [
            { memberIdentifier: "m-1", sourceKind: "agent", summary: "任务包事实正文" },
          ],
        },
      }),
    });
    const assembled = await provider({
      missionId: "mission-1",
      agentInstanceId: "worker-1",
      task: {
        id: "T-001",
        description: "probe",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
      } as never,
    });
    expect(assembled.promptText).toContain("任务包事实正文");
  }, 30_000);

  it("② 声明有包却读不到 ⇒ 阻塞（context-pack-unresolvable）", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory });
    const graphStore = new LocalContextGraphStore({ baseDirectory });
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore,
      maximumGlobalContextTokenCount: 4096,
      contextPackResolver: async () => ({
        kind: "declared-but-missing",
        reason: "映射指向的序列任务读不到",
      }),
    });
    await expect(
      provider({
        missionId: "mission-1",
        agentInstanceId: "worker-1",
        task: {
          id: "T-001",
          description: "probe",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
        } as never,
      }),
    ).rejects.toMatchObject({ errorCode: "context-pack-unresolvable" });
  }, 30_000);

  it("③ 未声明包 ⇒ 照常装配（不注入包区块）", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory });
    const graphStore = new LocalContextGraphStore({ baseDirectory });
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore,
      maximumGlobalContextTokenCount: 4096,
      contextPackResolver: async () => ({ kind: "no-pack-declared" }),
    });
    const assembled = await provider({
      missionId: "mission-1",
      agentInstanceId: "worker-1",
      task: {
        id: "T-001",
        description: "probe",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
      } as never,
    });
    expect(assembled.promptText).toContain("[系统规则]");
  }, 30_000);
});

describe("WIRING-04-05：显式回访内容注入", () => {
  it("① 提供的回访块（带节点与 revision）进入提示词", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory });
    const graphStore = new LocalContextGraphStore({ baseDirectory });
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore,
      maximumGlobalContextTokenCount: 4096,
      recalledContextBlocksProvider: async () => [
        {
          contextNodeIdentifier: "node-closed-1",
          sourceRevision: 4,
          text: "已关闭节点的正文内容",
        },
      ],
    });
    const assembled = await provider({
      missionId: "mission-1",
      agentInstanceId: "worker-1",
      task: {
        id: "T-001",
        description: "probe",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
      } as never,
    });
    expect(assembled.promptText).toContain("已关闭节点的正文内容");
  }, 30_000);

  it("② 未提供 ⇒ 不注入该区块（旧行为不变）", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory });
    const graphStore = new LocalContextGraphStore({ baseDirectory });
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore,
      maximumGlobalContextTokenCount: 4096,
    });
    const assembled = await provider({
      missionId: "mission-1",
      agentInstanceId: "worker-1",
      task: {
        id: "T-001",
        description: "probe",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
      } as never,
    });
    expect(assembled.promptText).not.toContain("已关闭节点的正文内容");
  }, 30_000);
});
