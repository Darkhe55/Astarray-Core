/**
 * T09A-R1-02：预算生效、按 revision 失效选择缓存、模型空间缩减与中文估算。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createContextPromptProvider,
  resolveContextBudget,
} from "../../../packages/core/src/orchestration/context-prompt-assembler.js";
import { GlobalDecisionStore, estimateGlobalDecisionTokenCount } from "../../../packages/core/src/orchestration/global-decision-store.js";
import { LocalContextGraphStore } from "../../../packages/core/src/orchestration/local-context-graph-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-t09a-budget-provider-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("T09A-R1-02：预算与选择缓存", () => {
  it("预算改为 0 后从下一请求生效（revision 使缓存失效）", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory: stateDirectory });
    await globalDecisionStore.promoteCandidate({
      decisionSummary: "BUDGETED-DECISION",
      keyRationale: "预算内注入",
      appliesToScope: "T-001",
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });
    let policy = {
      configuredMaximumGlobalContextTokenCount: 4096,
      globalContextBudgetPolicyRevision: 1,
    };
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore: new LocalContextGraphStore({ baseDirectory: stateDirectory }),
      maximumGlobalContextTokenCount: 4096,
      budgetPolicyProvider: async () => policy,
    });
    const input = {
      missionId: "mission-1",
      agentInstanceId: "agent-a",
      task: { id: "T-001", description: "probe", dependsOn: [], taskType: "data", toolNames: [] } as never,
    };
    const first = await provider(input);
    expect(first.injectedGlobalDecisionIdentifiers).toHaveLength(1);
    expect(first.promptText).toContain("BUDGETED-DECISION");

    policy = { configuredMaximumGlobalContextTokenCount: 0, globalContextBudgetPolicyRevision: 2 };
    const second = await provider(input);
    expect(second.injectedGlobalDecisionIdentifiers).toHaveLength(0);
    expect(second.promptText).not.toContain("BUDGETED-DECISION");
  });

  it("模型输入空间不足时取较小有效值并给出缩减原因", () => {
    const reduced = resolveContextBudget({
      configuredMaximumGlobalContextTokenCount: 4096,
      budgetPolicyRevision: 3,
      modelInputSpaceTokens: 512,
    });
    expect(reduced.effectiveMaximumGlobalContextTokenCount).toBe(512);
    expect(reduced.configuredMaximumGlobalContextTokenCount).toBe(4096);
    expect(reduced.budgetReductionReason).not.toBeNull();

    const notReduced = resolveContextBudget({
      configuredMaximumGlobalContextTokenCount: 4096,
      budgetPolicyRevision: 3,
      modelInputSpaceTokens: 8192,
    });
    expect(notReduced.effectiveMaximumGlobalContextTokenCount).toBe(4096);
    expect(notReduced.budgetReductionReason).toBeNull();
  });

  it("最高优先级决策放不下时阻塞，并先把未选中决策交给延后写入器", async () => {
    const globalDecisionStore = new GlobalDecisionStore({ baseDirectory: stateDirectory });
    await globalDecisionStore.promoteCandidate({
      decisionSummary: "MANDATORY-BUDGETED-DECISION-WITH-LONG-TEXT",
      keyRationale: "必须保留的当前任务约束",
      appliesToScope: "T-BUDGET",
      informationSource: { sourceType: "user" },
      sourceRevision: 1,
    });
    const deferredContextWriter = vi.fn(async () => undefined);
    const provider = createContextPromptProvider({
      globalDecisionStore,
      graphStore: new LocalContextGraphStore({ baseDirectory: stateDirectory }),
      maximumGlobalContextTokenCount: 5,
      deferredContextWriter,
    });
    await expect(
      provider({
        missionId: "mission-budget",
        agentInstanceId: "agent-budget",
        task: {
          id: "T-BUDGET",
          description: "probe",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
        } as never,
      }),
    ).rejects.toMatchObject({ errorCode: "context-budget-insufficient" });
    expect(deferredContextWriter).toHaveBeenCalledTimes(1);
  });

  it("中文估算按字符数/4 且至少 1 token", () => {
    expect(estimateGlobalDecisionTokenCount({ decisionSummary: "决策概要", keyRationale: "理由说明" })).toBe(2);
    expect(estimateGlobalDecisionTokenCount({ decisionSummary: "短", keyRationale: "" })).toBe(1);
  });
});
