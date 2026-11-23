/**
 * D8（2026-11-23）：PolicyWrapper 的拒绝/异常分支覆盖。
 *
 * 覆盖：取消、工作窗口拒绝、未注册、Worker 子集、安装门禁、权限询问/拒绝、
 * 自定义处理器抛普通错误/DomainError 的副作用状态、profile 解析失败回退。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { DomainError } from "../../../packages/core/src/core/errors.js";
import { GOAL_PROPOSAL_TOOL_DESCRIPTOR, GOAL_PROPOSAL_TOOL_NAME } from "../../../packages/core/src/tools/goal-proposal-tool.js";

const GOAL_ARGS = JSON.stringify({ objectiveText: "让构建稳定", requirements: [] });

let workspaceDirectory: string;

beforeEach(async () => {
  workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-pw-branches-"));
});

afterEach(async () => {
  await fs.rm(workspaceDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function buildWrapper(input: {
  mode?: "ponder" | "assist" | "devolve";
  overrides?: Record<string, unknown>;
  handler?: (argumentsJson: string, callId: string) => Promise<never>;
  workerAllowedToolNames?: Set<string> | null;
}) {
  const mode = input.mode ?? "assist";
  const modeMachine = new ModeMachine(mode);
  const registry = new ToolRegistry();
  registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
  registry.register(GOAL_PROPOSAL_TOOL_DESCRIPTOR, { isHiddenFromPreview: true });
  return new PolicyWrapper({
    permissionDecider: new PermissionDecider(modeMachine, new SessionAuthorizationManager()),
    registry,
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(workspaceDirectory, "temp"),
    workerAllowedToolNames: input.workerAllowedToolNames ?? null,
    nowUnixSeconds: () => 1_000_000,
    getCurrentMode: () => mode,
    requestingAgentInstanceId: "agent-a",
    taskExecutionId: "task-1",
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: workspaceDirectory,
    }),
    ...(input.handler === undefined
      ? {}
      : { customToolHandlers: new Map([[GOAL_PROPOSAL_TOOL_NAME, input.handler]]) }),
    ...(input.overrides ?? {}),
  } as never);
}

describe("PolicyWrapper 拒绝分支", () => {
  it("① 已取消的调用 ⇒ provider-cancelled 且确定无副作用", async () => {
    const wrapper = buildWrapper({});
    const controller = new AbortController();
    controller.abort();
    const result = await wrapper.execute("readFile", "{}", "call-1", controller.signal);
    expect(result).toMatchObject({
      kind: "error",
      errorCode: "provider-cancelled",
      sideEffectStatus: "none",
    });
  });

  it("② 工作窗口拒绝 ⇒ tool-permission-denied，不进入执行", async () => {
    const wrapper = buildWrapper({
      overrides: {
        workWindowGateProvider: async () => ({ isAllowed: false, reason: "不在工作窗口" }),
      },
    });
    const result = await wrapper.execute("readFile", "{}", "call-2", new AbortController().signal);
    expect(result).toMatchObject({
      kind: "error",
      errorCode: "tool-permission-denied",
      errorMessage: "不在工作窗口",
      sideEffectStatus: "none",
    });
  });

  it("③ 未注册工具 ⇒ tool-not-found", async () => {
    const wrapper = buildWrapper({});
    const result = await wrapper.execute("rmEverything", "{}", "call-3", new AbortController().signal);
    expect(result).toMatchObject({ kind: "error", errorCode: "tool-not-found" });
  });

  it("④ Worker 子集外 ⇒ tool-permission-denied", async () => {
    const wrapper = buildWrapper({ workerAllowedToolNames: new Set(["readFile"]) });
    const result = await wrapper.execute(
      GOAL_PROPOSAL_TOOL_NAME,
      GOAL_ARGS,
      "call-4",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "error", errorCode: "tool-permission-denied" });
  });

  it("⑥ ponder 模式 ⇒ 权限策略拒绝（deny 分支）", async () => {
    const handler = vi.fn(async () => ({ kind: "success", callId: "x", outputText: "", isSideEffectFree: true }));
    const wrapper = buildWrapper({ mode: "ponder", handler: handler as never });
    const result = await wrapper.execute(
      GOAL_PROPOSAL_TOOL_NAME,
      GOAL_ARGS,
      "call-6",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "error", errorCode: "tool-permission-denied" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("⑦ assist 模式未授权 ⇒ 权限询问待决，且确定无副作用", async () => {
    const handler = vi.fn(async () => ({ kind: "success", callId: "x", outputText: "", isSideEffectFree: true }));
    const wrapper = buildWrapper({ mode: "assist", handler: handler as never });
    const result = await wrapper.execute(
      GOAL_PROPOSAL_TOOL_NAME,
      GOAL_ARGS,
      "call-7",
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      kind: "error",
      errorCode: "permission-ask-pending",
      sideEffectStatus: "none",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("⑧ 处理器抛普通错误 ⇒ unknown + 结果未知（必须对账）", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const wrapper = buildWrapper({ mode: "devolve", handler: handler as never });
    /** 先授予会话授权，越过权限询问。 */
    const result = await wrapper.execute(
      GOAL_PROPOSAL_TOOL_NAME,
      GOAL_ARGS,
      "call-8",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: "error", errorCode: "tool-execution-failed" });
    if (result.kind === "error") {
      expect(result.sideEffectStatus).toBe("unknown");
      expect(result.errorMessage).toContain("boom");
    }
  });

  it("⑨ 处理器抛授权类 DomainError ⇒ 确定无副作用（可重试）", async () => {
    const handler = vi.fn(async () => {
      throw new DomainError("tool-permission-denied", "拒绝");
    });
    const wrapper = buildWrapper({ mode: "devolve", handler: handler as never });
    const result = await wrapper.execute(
      GOAL_PROPOSAL_TOOL_NAME,
      GOAL_ARGS,
      "call-9",
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      kind: "error",
      errorCode: "tool-permission-denied",
      sideEffectStatus: "none",
    });
  });

  it("⑩ profile 解析失败 ⇒ 回退旧裁决（不静默使用过期引用）", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("状态不可读");
    });
    const wrapper = buildWrapper({
      overrides: {
        configurablePermissionPolicyEngine: { decide: async () => "allow" },
        resolveCurrentPermissionProfileReference: resolver,
        currentPermissionProfileReference: { kind: "builtin", profileId: "assist" },
      },
    });
    await fs.writeFile(path.join(workspaceDirectory, "note.txt"), "内容", "utf8");
    const result = await wrapper.execute(
      "readFile",
      JSON.stringify({ filePath: "note.txt" }),
      "call-10",
      new AbortController().signal,
    );
    expect(result.kind).toBe("success");
    expect(resolver).toHaveBeenCalled();
  });
});
