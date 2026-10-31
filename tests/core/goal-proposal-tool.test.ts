/**
 * R92（2026-11-01）：③-A —— `proposeGoal` 工具描述符与权限映射的合法性单测。
 *
 * 只证明"描述符可被工具注册表接受、权限目录有映射"，**不证明执行已接线**
 * （③-B 才接执行；此阶段不把工具暴露给模型）。
 */
import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../../packages/core/src/tools/registry.js";
import { PermissionCapabilityCatalog } from "../../packages/core/src/tools/permission-capability-catalog.js";
import {
  GOAL_PROPOSAL_TOOL_DESCRIPTOR,
  GOAL_PROPOSAL_TOOL_NAME,
} from "../../packages/core/src/tools/goal-proposal-tool.js";

describe("proposeGoal 描述符（③-A）", () => {
  it("描述符字段完整且不声明为破坏性工具", () => {
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.name).toBe(GOAL_PROPOSAL_TOOL_NAME);
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.mutationKind).toBe("none");
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.backupPolicy).toBe("not-required");
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.isIdempotent).toBe(false);
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.inputSchema).toBeTypeOf("object");
  });

  it("权限目录有映射", () => {
    expect(
      new PermissionCapabilityCatalog().isToolMapped(GOAL_PROPOSAL_TOOL_NAME),
    ).toBe(true);
  });

  it("工具注册表接受该描述符并可查询", () => {
    const registry = new ToolRegistry();
    registry.register(GOAL_PROPOSAL_TOOL_DESCRIPTOR);
    expect(registry.getDescriptor(GOAL_PROPOSAL_TOOL_NAME)).not.toBeUndefined();
  });
});
