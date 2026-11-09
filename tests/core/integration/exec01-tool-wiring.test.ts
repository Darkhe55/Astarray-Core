/**
 * EXEC-01-01（2026-11-09）：**工具族接线与角色边界**的反例验证。
 *
 * 这里验证的是"入口可达且越界一律拒绝"，不是"沙箱可用"：
 * 沙箱真实隔离的验收在 EXEC-01-02 / 06。
 */
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import { MAIN_AGENT_READONLY_TOOL_NAMES } from "../../../packages/core/src/tools/main-agent-readonly-projection.js";
import { PONDER_READONLY_TOOL_NAMES } from "../../../packages/core/src/tools/local-tool-policy-engine.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import {
  PROCESS_EXECUTION_FAMILY,
  resolveToolAction,
  resolveUnifiedEntryInvocation,
  validateToolActionArguments,
} from "../../../packages/core/src/tools/tool-action-registry.js";
import {
  ExecutionEnvironmentRegistry,
  type ExecutionEnvironmentPolicy,
} from "../../../packages/core/src/execution/execution-contract.js";
import {
  ProcessExecutionController,
  type SandboxExecutionBackend,
} from "../../../packages/core/src/execution/process-execution-controller.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";

const environment: ExecutionEnvironmentPolicy = {
  environmentIdentifier: "node-offline-22",
  toolchainVersion: "node-22.11.0+stdlib",
  executableIdentifiers: { "run-test": "/sandbox/bin/node" },
  allowedInputProjectRelativePrefixes: ["src"],
  allowedOutputProjectRelativePrefixes: ["tmp"],
  resourcePolicy: {
    maximumCpuMilliseconds: 60_000,
    maximumMemoryBytes: 512 * 1024 * 1024,
    maximumProcessCount: 8,
    maximumDiskBytes: 256 * 1024 * 1024,
  },
  isNetworkAllowed: false,
};

const ownership = {
  projectIdentifier: "project-a",
  agentInstanceIdentifier: "tertiary-agent-1",
  missionIdentifier: "mission-1",
  taskIdentifier: "task-1",
  attemptNumber: 1,
  authorizationRevision: 1,
} as const;

const minimalBackend: SandboxExecutionBackend = {
  probeCapability: async () => ({
    isAvailable: true,
    backendIdentifier: "test-double",
    isolationPrimitiveDescription: "测试替身（非真实隔离）",
    reasonUnavailable: null,
  }),
  start: async (input) => ({
    backendExecutionHandle: `handle-${input.identity.executionId}`,
    status: "running",
  }),
  readStatus: async () => ({ status: "running", exitCode: null, failureReason: null }),
  readOutputStream: async (input) => ({
    text: "",
    nextCursorBytes: input.fromCursorBytes,
    isTruncated: false,
  }),
  cancel: async () => ({ status: "cancelled", exitCode: null, failureReason: "cancelled" }),
};

function createRegistry(): ExecutionEnvironmentRegistry {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(environment);
  return registry;
}

function createExecutionContext(
  overrides: Record<string, unknown> = {},
): Parameters<typeof executeBuiltinTool>[2] {
  return {
    workspaceBoundary: new WorkspaceBoundary(process.cwd()),
    temporaryDirectoryPath: process.cwd(),
    requestingAgentInstanceId: "tertiary-agent-1",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: path.join(os.tmpdir(), "astarray-exec01-state"),
    }),
    processExecutionController: new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: minimalBackend,
    }),
    processExecutionOwnership: ownership,
    ...overrides,
  } as Parameters<typeof executeBuiltinTool>[2];
}

describe("EXEC-01-01 工具族：单一工具名 + 四个 action", () => {
  it("族名就是实现名（不建立多个近义工具）", () => {
    expect(PROCESS_EXECUTION_FAMILY.familyName).toBe("processExecution");
    for (const action of PROCESS_EXECUTION_FAMILY.actions) {
      expect(action.implementationToolName).toBe("processExecution");
      expect(action.aliases).toEqual([]);
    }
    expect(PROCESS_EXECUTION_FAMILY.actions.map((action) => action.action)).toEqual([
      "start",
      "status",
      "readOutput",
      "cancel",
    ]);
  });

  it("逐 action 如实声明副作用（start 不是只读）", () => {
    const start = PROCESS_EXECUTION_FAMILY.actions.find((action) => action.action === "start");
    const status = PROCESS_EXECUTION_FAMILY.actions.find((action) => action.action === "status");
    const cancel = PROCESS_EXECUTION_FAMILY.actions.find((action) => action.action === "cancel");
    expect(start?.isReadOnly).toBe(false);
    expect(start?.isIdempotent).toBe(false);
    expect(status?.isReadOnly).toBe(true);
    expect(cancel?.isReadOnly).toBe(false);
  });

  it("统一入口解析到同一实现名（不会无限递归，也不会丢 action）", () => {
    const resolved = resolveUnifiedEntryInvocation(
      "processExecution",
      JSON.stringify({ action: "status", executionId: "exec-1" }),
    );
    expect(resolved.isUnifiedEntryRequest).toBe(true);
    expect(resolved.concreteToolName).toBe("processExecution");
  });

  it("未知 action 与跨 action 参数被拒绝", () => {
    expect(resolveToolAction({ toolNameOrAlias: "processExecution", action: "shell" })).toBeNull();
    expect(
      validateToolActionArguments({
        toolNameOrAlias: "processExecution",
        action: "status",
        argumentsJson: JSON.stringify({ action: "status", executionId: "e", arguments: [] }),
      }).isValid,
    ).toBe(false);
  });
});

describe("EXEC-01-01 工具执行：越界与缺装配一律拒绝", () => {
  it("未知 action 直接拒绝", async () => {
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({ action: "shell", command: "rm -rf /" }),
        createExecutionContext(),
      ),
    ).rejects.toThrow(/未知的族名\/别名与 action 组合/u);
  });

  it("宿主命令字段被拒绝（不是静默忽略）", async () => {
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
          command: "node --test",
        }),
        createExecutionContext(),
      ),
    ).rejects.toThrow(/参数非法/u);
  });

  it("未装配控制器 ⇒ 明确不可用（不降级宿主执行）", async () => {
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
        }),
        createExecutionContext({ processExecutionController: null }),
      ),
    ).rejects.toThrow(/未装配沙箱执行后端/u);
  });

  it("缺执行归属 ⇒ 拒绝（不接受模型自报 project/mission/attempt）", async () => {
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
        }),
        createExecutionContext({ processExecutionOwnership: null }),
      ),
    ).rejects.toThrow(/缺少执行归属/u);
  });

  it("归属主体与调用主体不一致 ⇒ 拒绝", async () => {
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
        }),
        createExecutionContext({
          processExecutionOwnership: { ...ownership, agentInstanceIdentifier: "someone-else" },
        }),
      ),
    ).rejects.toThrow(/归属与调用主体不一致/u);
  });

  it("start 成功时声明有副作用；status 声明无副作用", async () => {
    /** 同一个上下文 = 同一个控制器与存储（否则 status 查不到 start 的执行）。 */
    const executionContext = createExecutionContext();
    const startResult = await executeBuiltinTool(
      "processExecution",
      JSON.stringify({
        action: "start",
        environmentIdentifier: "node-offline-22",
        executableIdentifier: "run-test",
        arguments: ["--test"],
        workingDirectory: "src",
      }),
      executionContext,
    );
    expect(startResult.isSideEffectFree).toBe(false);
    const parsedStart = JSON.parse(startResult.outputText) as { executionId: string };
    expect(parsedStart.executionId).toMatch(/^exec-/u);

    const statusResult = await executeBuiltinTool(
      "processExecution",
      JSON.stringify({ action: "status", executionId: parsedStart.executionId }),
      executionContext,
    );
    expect(statusResult.isSideEffectFree).toBe(true);
  });
});

describe("EXEC-01-01 角色边界：主 Agent 与 ponder 都拿不到执行工具", () => {
  it("主 Agent 只读投影不含 processExecution", () => {
    expect([...MAIN_AGENT_READONLY_TOOL_NAMES]).not.toContain("processExecution");
  });

  it("ponder 只读白名单不含 processExecution", () => {
    expect([...PONDER_READONLY_TOOL_NAMES]).not.toContain("processExecution");
  });
});

describe("EXEC-01-01 权限：逐 action 映射，未登记 action 回退整工具", () => {
  it("start/status/readOutput/cancel 各自映射到不同能力", () => {
    const catalog = new PermissionCapabilityCatalog();
    expect(catalog.getCapabilityIdsForCall("processExecution", "start")).toEqual([
      "process.execute-sandboxed",
    ]);
    expect(catalog.getCapabilityIdsForCall("processExecution", "status")).toEqual([
      "process.read",
    ]);
    expect(catalog.getCapabilityIdsForCall("processExecution", "readOutput")).toEqual([
      "process.read",
    ]);
    expect(catalog.getCapabilityIdsForCall("processExecution", "cancel")).toEqual([
      "process.control",
    ]);
  });

  it("未登记 action 回退整工具映射（不因未登记而放宽）", () => {
    const catalog = new PermissionCapabilityCatalog();
    expect(catalog.getCapabilityIdsForCall("processExecution", "unknown-action")).toEqual([
      "process.execute-sandboxed",
    ]);
    expect(catalog.getCapabilityIdsForCall("processExecution", null)).toEqual([
      "process.execute-sandboxed",
    ]);
  });

  it("assist 下只读查询放行、start 需询问、取消需询问", () => {
    const catalog = new PermissionCapabilityCatalog();
    const decisions: Record<string, "allow" | "ask" | "deny"> = {
      "process.execute-sandboxed": "ask",
      "process.read": "allow",
      "process.control": "ask",
    };
    expect(
      catalog.evaluateToolPermission({
        toolName: "processExecution",
        action: "status",
        capabilityDecisions: decisions,
      }),
    ).toBe("allow");
    expect(
      catalog.evaluateToolPermission({
        toolName: "processExecution",
        action: "start",
        capabilityDecisions: decisions,
      }),
    ).toBe("ask");
    expect(
      catalog.evaluateToolPermission({
        toolName: "processExecution",
        action: "cancel",
        capabilityDecisions: decisions,
      }),
    ).toBe("ask");
  });

  it("未映射工具仍然 deny（不因新增映射放宽既有规则）", () => {
    const catalog = new PermissionCapabilityCatalog();
    expect(
      catalog.evaluateToolPermission({
        toolName: "processExecution",
        action: "start",
        capabilityDecisions: {},
      }),
    ).toBe("deny");
  });

  it("目录版本随能力变化递增", () => {
    const catalog = new PermissionCapabilityCatalog();
    expect(catalog.getCatalogVersion()).toBe(2);
    expect(catalog.getCapability("process.read")).toBeDefined();
    expect(catalog.getCapability("process.control")).toBeDefined();
  });
});

describe("EXEC-01-01 错误码", () => {
  it("新增错误码可构造且默认不可恢复", () => {
    for (const errorCode of [
      "execution-environment-invalid",
      "execution-environment-not-found",
      "execution-request-invalid",
      "execution-backend-unsupported",
      "execution-not-found",
      "execution-not-authorized",
      "execution-idempotency-conflict",
    ] as const) {
      const error = new DomainError(errorCode, "x");
      expect(error.errorCode).toBe(errorCode);
      expect(error.isRecoverable).toBe(false);
    }
  });
});
