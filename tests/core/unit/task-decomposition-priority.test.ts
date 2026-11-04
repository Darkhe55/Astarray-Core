/**
 * ALIGN-02-03（2026-11-05）：执行节点优先级由本地契约固定，不由模型稿决定。
 */
import { describe, expect, it } from "vitest";

import {
  buildSingleNodeDecomposition,
  parseAndValidateTaskDecomposition,
} from "../../../packages/core/src/orchestration/task-decomposition-contract.js";

describe("任务分解优先级", () => {
  it("规划节点恒为 Agent 层 1，且状态为 pending", () => {
    const nodes = parseAndValidateTaskDecomposition({
      draft: {
        nodes: [
          {
            id: "T-1",
            description: "实现",
            acceptanceCriteria: "测试通过",
            dependsOn: [],
            toolNames: [],
          },
        ],
      },
      availableToolNames: [],
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.priorityTier).toBe(1);
    expect(nodes[0]?.status).toBe("pending");
  });

  it("候选稿自带 priorityTier 会被拒绝（不能伪造用户层）", () => {
    expect(() =>
      parseAndValidateTaskDecomposition({
        draft: {
          nodes: [
            {
              id: "T-1",
              description: "实现",
              acceptanceCriteria: "测试通过",
              priorityTier: 0,
            },
          ],
        },
        availableToolNames: [],
      }),
    ).toThrow(/不支持的字段/u);
  });

  it("单节点降级保持用户层（不声称已规划）", () => {
    const fallback = buildSingleNodeDecomposition({
      instructionText: "直接做",
      availableToolNames: [],
      fallbackReason: "无可用规划",
    });
    expect(fallback.isFallback).toBe(true);
    expect(fallback.nodes[0]?.priorityTier).toBeUndefined();
  });
});
