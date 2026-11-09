/**
 * EXEC-01-03（2026-11-09）：**终止原因分类**。
 *
 * 缺口：`cancelled` 同时覆盖"调用方取消"与"权限撤销"，只靠 `failureReason`
 * 的自由文本无法可靠区分 ⇒ 无法据此决定"能不能重试"。
 *
 * 本文件钉住：调用方取消 = `caller-cancelled`，权限撤销 = `authorization-revoked`，
 * 后端超时 = `timed-out`，后端失败 = `backend-failed`；**不得混为一谈**。
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryProcessExecutionStore,
  ProcessExecutionController,
} from "../../../packages/core/src/execution/process-execution-controller.js";
import {
  ExecutionEnvironmentRegistry,
  type ExecutionEnvironmentPolicy,
} from "../../../packages/core/src/execution/execution-contract.js";
import type {
  SandboxCapabilityProfile,
  SandboxExecutionBackend,
  SandboxExecutionSnapshot,
  SandboxStartOutcome,
} from "../../../packages/core/src/execution/process-execution-controller.js";

const ENVIRONMENT_POLICY: ExecutionEnvironmentPolicy = {
  environmentIdentifier: "term-env",
  toolchainVersion: "term-1",
  executableIdentifiers: { node: "node" },
  allowedInputProjectRelativePrefixes: ["docs/"],
  allowedOutputProjectRelativePrefixes: ["out/"],
  resourcePolicy: {
    maximumCpuMilliseconds: 10_000,
    maximumMemoryBytes: 64 * 1024 * 1024,
    maximumProcessCount: 2,
    maximumDiskBytes: 8 * 1024 * 1024,
  },
  isNetworkAllowed: false,
};

/** 可切换终态的后端：用于构造"超时"与"失败"两种终止。 */
function buildBackend(terminal: SandboxExecutionSnapshot): SandboxExecutionBackend {
  let isTerminal = false;
  return {
    async probeCapability(): Promise<SandboxCapabilityProfile> {
      return {
        isAvailable: true,
        backendIdentifier: "term-test-backend",
        isolationPrimitiveDescription: "测试后端（非真实隔离）",
        reasonUnavailable: null,
      };
    },
    async start(): Promise<SandboxStartOutcome> {
      return { backendExecutionHandle: "handle-term", status: "running" };
    },
    async readStatus(): Promise<SandboxExecutionSnapshot> {
      return isTerminal ? terminal : { status: "running", exitCode: null, failureReason: null };
    },
    async readOutputStream() {
      return { text: "", nextCursorBytes: 0, isTruncated: false };
    },
    async cancel(): Promise<SandboxExecutionSnapshot> {
      return { status: "cancelled", exitCode: null, failureReason: "调用方取消" };
    },
    /** 让下一次 `readStatus` 返回终态。 */
    __finish() {
      isTerminal = true;
    },
  } as SandboxExecutionBackend & { __finish(): void };
}

async function startExecution(backend: SandboxExecutionBackend) {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(ENVIRONMENT_POLICY);
  const controller = new ProcessExecutionController({
    environmentRegistry: registry,
    store: new InMemoryProcessExecutionStore(),
    sandboxBackend: backend,
  });
  const started = await controller.start({
    ownership: {
      projectIdentifier: "project-a",
      agentInstanceIdentifier: "agent-1",
      missionIdentifier: null,
      taskIdentifier: "task-1",
      attemptNumber: 1,
      authorizationRevision: 1,
    },
    request: {
      environmentIdentifier: "term-env",
      executableIdentifier: "node",
      arguments: ["-e", "1"],
      workingDirectory: "docs",
    },
  });
  return { controller, executionId: started.executionId };
}

describe("EXEC-01-03 终止原因分类", () => {
  it("调用方取消 ⇒ caller-cancelled", async () => {
    const { controller, executionId } = await startExecution(
      buildBackend({ status: "cancelled", exitCode: null, failureReason: null }),
    );
    const cancelled = await controller.cancel({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId,
      reason: "用户取消",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.terminationKind).toBe("caller-cancelled");
  }, 30_000);

  it("权限撤销 ⇒ authorization-revoked（与调用方取消分开）", async () => {
    const { controller, executionId } = await startExecution(
      buildBackend({ status: "cancelled", exitCode: null, failureReason: null }),
    );
    const revoked = await controller.cancel({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId,
      reason: "授权被撤销",
      terminationKind: "authorization-revoked",
    });
    expect(revoked.status).toBe("cancelled");
    expect(revoked.terminationKind).toBe("authorization-revoked");
    /** 不得退化成 caller-cancelled（那会允许自动重试）。 */
    expect(revoked.terminationKind).not.toBe("caller-cancelled");
  }, 30_000);

  it("后端超时 ⇒ timed-out（由后端状态推导，不由调用方自述）", async () => {
    const backend = buildBackend({
      status: "timed-out",
      exitCode: null,
      failureReason: "超过时限",
    });
    const { controller, executionId } = await startExecution(backend);
    (backend as unknown as { __finish(): void }).__finish();
    const status = await controller.readStatus({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId,
    });
    expect(status.status).toBe("timed-out");
    expect(status.terminationKind).toBe("timed-out");
  }, 30_000);

  it("后端失败 ⇒ backend-failed", async () => {
    const backend = buildBackend({
      status: "failed",
      exitCode: 1,
      failureReason: "进程异常退出",
    });
    const { controller, executionId } = await startExecution(backend);
    (backend as unknown as { __finish(): void }).__finish();
    const status = await controller.readStatus({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId,
    });
    expect(status.status).toBe("failed");
    expect(status.terminationKind).toBe("backend-failed");
  }, 30_000);

  it("仍在运行 ⇒ 终止原因为 null（不得提前填一个）", async () => {
    const { controller, executionId } = await startExecution(
      buildBackend({ status: "succeeded", exitCode: 0, failureReason: null }),
    );
    const status = await controller.readStatus({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId,
    });
    expect(status.status).toBe("running");
    expect(status.terminationKind).toBeNull();
  }, 30_000);
});
