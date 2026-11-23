/**
 * RESUME-02 检查点 04 测试（2026-11-24）：有界恢复包。
 *
 * 反例重点：
 * - 未知窗口不猜（blocked）；
 * - 安全约束超预算 ⇒ 阻塞（绝不静默截断）；
 * - 无关/已关闭节点移出但记引用（内容留磁盘）；
 * - 当前前置节点优先入选；
 * - 全局 4096 预算与窗口预算取更严。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTINUATION_GLOBAL_BUDGET_TOKENS,
  assembleContinuationPack,
  type ContinuationPackNode,
  type ContinuationPackRequest,
} from "../../../packages/core/src/orchestration/continuation-context-pack.js";

function node(overrides: Partial<ContinuationPackNode> = {}): ContinuationPackNode {
  return {
    taskIdentifier: "T-1",
    revision: 3,
    contentHash: "hash-1",
    estimatedTokens: 100,
    isClosedOrIrrelevant: false,
    isCurrentPrerequisite: false,
    securityConstraints: [],
    excerpt: "节点正文",
    ...overrides,
  };
}

function request(overrides: Partial<ContinuationPackRequest> = {}): ContinuationPackRequest {
  return {
    targetTaskIdentifier: "T-1",
    expectedRevision: 3,
    modelWindowTokens: 8_000,
    systemAndToolTokens: 1_000,
    outputReserveTokens: 1_000,
    safetyMarginTokens: 1_000,
    nodes: [node()],
    isTokenEstimate: false,
    ...overrides,
  };
}

describe("RESUME-02 检查点 04：恢复包装配", () => {
  it("① 未知窗口 ⇒ blocked（不猜测无限窗口）", () => {
    expect(assembleContinuationPack(request({ modelWindowTokens: null }))).toMatchObject({
      kind: "blocked",
      reasonCode: "model-window-unknown",
    });
  });

  it("② 扣减后预算 ≤ 0 ⇒ blocked", () => {
    expect(
      assembleContinuationPack(
        request({ modelWindowTokens: 2_000, systemAndToolTokens: 1_000, outputReserveTokens: 800, safetyMarginTokens: 400 }),
      ),
    ).toMatchObject({ kind: "blocked", reasonCode: "budget-non-positive" });
  });

  it("③ 全局预算 4096 与窗口预算取更严", () => {
    const result = assembleContinuationPack(
      request({
        modelWindowTokens: 1_000_000,
        systemAndToolTokens: 1_000,
        outputReserveTokens: 1_000,
        safetyMarginTokens: 1_000,
        nodes: [node({ estimatedTokens: 4_000 })],
      }),
    );
    expect(result.kind).toBe("assembled");
    if (result.kind === "assembled") {
      expect(result.availableTokens).toBe(DEFAULT_CONTINUATION_GLOBAL_BUDGET_TOKENS);
      /** 4000 token 节点放不进 4096（还要算约束，但这里无约束，4000 ≤ 4096）⇒ 应入选。 */
      expect(result.entries).toHaveLength(1);
    }
  });

  it("④ 安全约束超预算 ⇒ 阻塞，不静默截断", () => {
    const constraint = "约束：".repeat(4_000);
    const result = assembleContinuationPack(
      request({
        globalBudgetTokens: 500,
        nodes: [node({ securityConstraints: [constraint] })],
      }),
    );
    expect(result).toMatchObject({
      kind: "blocked",
      reasonCode: "security-constraints-exceed-budget",
    });
  });

  it("⑤ 无关/已关闭节点移出并记录引用（内容留磁盘）", () => {
    const result = assembleContinuationPack(
      request({
        nodes: [
          node({ taskIdentifier: "T-old", isClosedOrIrrelevant: true }),
          node({ taskIdentifier: "T-1" }),
        ],
      }),
    );
    expect(result.kind).toBe("assembled");
    if (result.kind === "assembled") {
      expect(result.entries.map((entry) => entry.taskIdentifier)).toEqual(["T-1"]);
      expect(result.leftOnDiskTaskIdentifiers).toContain("T-old");
    }
  });

  it("⑥ 当前前置节点优先（即使输入顺序靠后）", () => {
    const result = assembleContinuationPack(
      request({
        globalBudgetTokens: 150,
        nodes: [
          node({ taskIdentifier: "T-later", estimatedTokens: 100 }),
          node({ taskIdentifier: "T-prereq", estimatedTokens: 100, isCurrentPrerequisite: true }),
        ],
      }),
    );
    expect(result.kind).toBe("assembled");
    if (result.kind === "assembled") {
      expect(result.entries.map((entry) => entry.taskIdentifier)).toEqual(["T-prereq"]);
      expect(result.leftOnDiskTaskIdentifiers).toContain("T-later");
    }
  });

  it("⑦ 预算不足到装不下任何节点 ⇒ blocked（不空包冒充恢复）", () => {
    const result = assembleContinuationPack(
      request({ globalBudgetTokens: 50, nodes: [node({ estimatedTokens: 100 })] }),
    );
    expect(result).toMatchObject({ kind: "blocked", reasonCode: "minimal-pack-exceeds-budget" });
  });

  it("⑧ 估算标记随结果透出；装配绑定 revision/hash", () => {
    const result = assembleContinuationPack(request({ isTokenEstimate: true }));
    expect(result.kind).toBe("assembled");
    if (result.kind === "assembled") {
      expect(result.isTokenEstimate).toBe(true);
      expect(result.entries[0]).toMatchObject({
        taskIdentifier: "T-1",
        revision: 3,
        contentHash: "hash-1",
        isCurrentPrerequisite: false,
      });
      expect(result.securityConstraintCount).toBe(0);
    }
  });
});
