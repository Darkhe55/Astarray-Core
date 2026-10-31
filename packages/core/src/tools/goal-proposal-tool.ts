/**
 * R92（2026-11-01）：**模型可提议目标的工具描述符**（③-A）。
 *
 * 目标模式的边界：模型只能**提议**目标（落提案），用户确认后才生成契约。
 * 本文件只定义描述符与权限映射，**不注册进运行时**（避免在能力接线完成前
 * 让模型看到一个"能调但执行未接"的工具）。
 *
 * ③-B 会做：目标模式激活时把该描述符加入任务工具集，并把执行接到
 * `proposeGoalContract`。
 */
import type { ToolDescriptor } from "../core/types.js";

export const GOAL_PROPOSAL_TOOL_NAME = "proposeGoal";

export const GOAL_PROPOSAL_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: GOAL_PROPOSAL_TOOL_NAME,
  summary:
    "提议一个目标（只生成待确认提案；不会自动启用目标模式，也不会创建契约）",
  category: "readonly",
  mutationKind: "none",
  backupPolicy: "not-required",
  authorizationPolicy: "standard",
  supportedTaskTypes: ["data", "doc", "code"],
  /** 同一目标文本重复提议应当被去重/拒绝，故不声明幂等。 */
  isIdempotent: false,
  inputSchema: {
    type: "object",
    properties: {
      objectiveText: { type: "string" },
      sourceRequestReference: { type: "string" },
      requirements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requirementIdentifier: { type: "string" },
            description: { type: "string" },
            weight: { type: "number" },
            completionPredicateKind: {
              type: "string",
              enum: ["deterministic-check", "independent-acceptance"],
            },
          },
          required: ["requirementIdentifier", "description", "weight"],
        },
      },
    },
    required: ["objectiveText", "requirements"],
  },
};
