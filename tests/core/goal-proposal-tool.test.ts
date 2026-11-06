/**
 * AUDIT-REPAIR-01（2026-11-06）：`proposeGoal` 描述符、权限映射与处理器。
 *
 * 与旧测试的区别：工具现在是**写工具**（create-only），不得再声明只读/none；
 * 处理器只做校验与落提案，权限由 PolicyWrapper 先行执行。
 */
import { describe, expect, it, vi } from "vitest";

import { ToolRegistry } from "../../packages/core/src/tools/registry.js";
import { PermissionCapabilityCatalog } from "../../packages/core/src/tools/permission-capability-catalog.js";
import {
  GOAL_PROPOSAL_TOOL_DESCRIPTOR,
  GOAL_PROPOSAL_TOOL_NAME,
  createGoalProposalToolHandler,
} from "../../packages/core/src/tools/goal-proposal-tool.js";

describe("proposeGoal 描述符", () => {
  it("声明为受限的仅新建工具，不再冒充只读", () => {
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.name).toBe(GOAL_PROPOSAL_TOOL_NAME);
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.category).toBe("restricted");
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.mutationKind).toBe("create-only");
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.backupPolicy).toBe("not-required");
    expect(GOAL_PROPOSAL_TOOL_DESCRIPTOR.isIdempotent).toBe(true);
  });

  it("权限目录映射到专用 goal.propose 能力", () => {
    const catalog = new PermissionCapabilityCatalog();
    expect(catalog.isToolMapped(GOAL_PROPOSAL_TOOL_NAME)).toBe(true);
    const capability = catalog
      .listCapabilities()
      .find((entry) => entry.capabilityId === "goal.propose");
    expect(capability?.toolMappings).toContain(GOAL_PROPOSAL_TOOL_NAME);
  });

  it("注册表接受该描述符，但不进入主 Agent 预览", () => {
    const registry = new ToolRegistry();
    registry.register(GOAL_PROPOSAL_TOOL_DESCRIPTOR, { isHiddenFromPreview: true });
    expect(registry.getDescriptor(GOAL_PROPOSAL_TOOL_NAME)).not.toBeUndefined();
    expect(
      registry.getPreviewDescriptors().some((entry) => entry.name === GOAL_PROPOSAL_TOOL_NAME),
    ).toBe(false);
    expect(
      registry.getFullDescriptors().some((entry) => entry.name === GOAL_PROPOSAL_TOOL_NAME),
    ).toBe(true);
  });
});

describe("proposeGoal 处理器", () => {
  const validArguments = JSON.stringify({
    objectiveText: "让构建稳定",
    requirements: [
      { requirementIdentifier: "r1", description: "测试通过", weight: 1 },
    ],
  });

  it("目标未激活 / 缺 mission / 非法参数 ⇒ 错误且不落提案", async () => {
    const propose = vi.fn(async () => ({
      proposalIdentifier: "proposal-1",
      expiresAtIso: "2026-11-06T00:00:00.000Z",
    }));
    const inactive = createGoalProposalToolHandler({
      isGoalModeActivated: () => false,
      missionIdentifier: "mission-1",
      proposeGoalContract: propose,
    });
    expect((await inactive(validArguments, "call-1")).kind).toBe("error");

    const missingMission = createGoalProposalToolHandler({
      isGoalModeActivated: () => true,
      missionIdentifier: undefined,
      proposeGoalContract: propose,
    });
    expect((await missingMission(validArguments, "call-2")).kind).toBe("error");

    const active = createGoalProposalToolHandler({
      isGoalModeActivated: () => true,
      missionIdentifier: "mission-1",
      proposeGoalContract: propose,
    });
    expect((await active("{not json", "call-3")).kind).toBe("error");
    expect((await active(JSON.stringify({ requirements: [] }), "call-4")).kind).toBe("error");
    expect(propose).not.toHaveBeenCalled();
  });

  it("成功落一个提案；同一 callId 重试不重复落盘", async () => {
    const propose = vi.fn(
      async (_request: { draft: unknown; sourceRequestReference: string }) => ({
        proposalIdentifier: "proposal-1",
        expiresAtIso: "2026-11-06T00:00:00.000Z",
      }),
    );
    const handler = createGoalProposalToolHandler({
      isGoalModeActivated: () => true,
      missionIdentifier: "mission-1",
      proposeGoalContract: propose,
    });
    const first = await handler(validArguments, "call-1");
    expect(first.kind).toBe("success");
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0]?.[0].sourceRequestReference).toBe("mission:mission-1");

    const retry = await handler(validArguments, "call-1");
    expect(retry.kind).toBe("success");
    expect(propose).toHaveBeenCalledTimes(1);

    await handler(validArguments, "call-2");
    expect(propose).toHaveBeenCalledTimes(2);
  });
});
