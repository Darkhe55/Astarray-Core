/**
 * AUDIT-REPAIR-01（2026-11-06）检查点 01：proposeGoal 不再绕过统一门禁。
 *
 * 反例：在 ponder（全拒）模式下，即使处理器存在也不得被调用；
 * 允许模式（devolve）下才进入处理器。这直接证明旧"旁路"已删除。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import { PermissionDecider, SessionAuthorizationManager } from "../../../packages/core/src/core/permission-policy.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { GOAL_PROPOSAL_TOOL_DESCRIPTOR, GOAL_PROPOSAL_TOOL_NAME } from "../../../packages/core/src/tools/goal-proposal-tool.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let workspaceDirectory: string;

beforeEach(async () => {
  workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-goal-gate-"));
});

afterEach(async () => {
  await fs.rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
});

function buildWrapper(input: {
  mode: "ponder" | "devolve";
  handler: (argumentsJson: string, callId: string) => Promise<{
    kind: "success";
    callId: string;
    outputText: string;
    isSideEffectFree: boolean;
  }>;
}) {
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  registry.register(GOAL_PROPOSAL_TOOL_DESCRIPTOR, { isHiddenFromPreview: true });
  return new PolicyWrapper({
    permissionDecider: new PermissionDecider(
      new ModeMachine(input.mode),
      new SessionAuthorizationManager(),
    ),
    registry,
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(workspaceDirectory, "temp"),
    workerAllowedToolNames: new Set([GOAL_PROPOSAL_TOOL_NAME]),
    nowUnixSeconds: () => Math.floor(Date.now() / 1000),
    getCurrentMode: () => input.mode,
    protectedStoragePolicy: new ProtectedStoragePolicy({ stateDirectoryPath: workspaceDirectory }),
    customToolHandlers: new Map([[GOAL_PROPOSAL_TOOL_NAME, input.handler]]),
  });
}

const validArguments = JSON.stringify({
  objectiveText: "让构建稳定",
  requirements: [],
});

describe("proposeGoal 统一门禁", () => {
  it("ponder 模式拒绝，处理器不被调用", async () => {
    const handler = vi.fn(async (_argumentsJson: string, callId: string) => ({
      kind: "success" as const,
      callId,
      outputText: "不应发生",
      isSideEffectFree: false,
    }));
    const wrapper = buildWrapper({ mode: "ponder", handler });
    const result = await wrapper.execute(
      GOAL_PROPOSAL_TOOL_NAME,
      validArguments,
      "call-ponder-1",
      new AbortController().signal,
    );
    expect(result.kind).toBe("error");
    expect((result as { errorCode?: string }).errorCode).toBe("tool-permission-denied");
    expect(handler).not.toHaveBeenCalled();
  });

  it("允许模式进入处理器（且不再有专属旁路）", async () => {
    const handler = vi.fn(async (_argumentsJson: string, callId: string) => ({
      kind: "success" as const,
      callId,
      outputText: "目标提案已创建: proposal-1",
      isSideEffectFree: false,
    }));
    const wrapper = buildWrapper({ mode: "devolve", handler });
    const result = await wrapper.execute(
      GOAL_PROPOSAL_TOOL_NAME,
      validArguments,
      "call-devolve-1",
      new AbortController().signal,
    );
    expect(result.kind).toBe("success");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
