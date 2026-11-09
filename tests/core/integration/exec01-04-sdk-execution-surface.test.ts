/**
 * EXEC-01-04（2026-11-09）：**公开 SDK 的执行查询/读取/取消**。
 *
 * 缺口：控制器已具备 `readStatus` / `readOutput` / `cancel`，但**没有任何公开入口**
 * 调用它们 ⇒ 外部只能看任务状态，看不到受控执行的输出，也无法取消。
 *
 * 本文件钉住三件事：
 *  1. 查询返回**状态视图**，不泄漏后端句柄；
 *  2. 输出按字节游标读取，且**返回前脱敏**（不得把密钥交给 SDK 调用方）；
 *  3. 取消后状态可查且为 cancelled。
 *
 * 这里用的是**测试后端**：它只证明 SDK 通路与脱敏，**不声称隔离成立**
 * （隔离的真实验证见 `docs/reports/EXEC01_02_B1_WINDOWS_SANDBOX_VERIFICATION_2026-11-09.md`）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import type {
  SandboxCapabilityProfile,
  SandboxExecutionBackend,
  SandboxExecutionSnapshot,
  SandboxOutputStreamChunk,
  SandboxStartOutcome,
} from "../../../packages/core/src/execution/process-execution-controller.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-exec-sdk-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildTestBackend(outputText: string): SandboxExecutionBackend {
  const snapshots = new Map<string, SandboxExecutionSnapshot>();
  let sequence = 0;
  return {
    async probeCapability(): Promise<SandboxCapabilityProfile> {
      return {
        isAvailable: true,
        backendIdentifier: "test-backend",
        isolationPrimitiveDescription: "测试后端（非真实隔离）",
        reasonUnavailable: null,
      };
    },
    async start(): Promise<SandboxStartOutcome> {
      sequence += 1;
      const backendExecutionHandle = "handle-" + String(sequence);
      snapshots.set(backendExecutionHandle, {
        status: "running",
        exitCode: null,
        failureReason: null,
      });
      return { backendExecutionHandle, status: "running" };
    },
    async readStatus(backendExecutionHandle: string): Promise<SandboxExecutionSnapshot> {
      return (
        snapshots.get(backendExecutionHandle) ?? {
          status: "failed",
          exitCode: null,
          failureReason: "未知句柄",
        }
      );
    },
    async readOutputStream(): Promise<SandboxOutputStreamChunk> {
      return {
        text: outputText,
        nextCursorBytes: Buffer.byteLength(outputText, "utf8"),
        isTruncated: false,
      };
    },
    async cancel(backendExecutionHandle: string): Promise<SandboxExecutionSnapshot> {
      const cancelled: SandboxExecutionSnapshot = {
        status: "cancelled",
        exitCode: null,
        failureReason: "调用方取消",
      };
      snapshots.set(backendExecutionHandle, cancelled);
      return cancelled;
    },
  };
}

/** 通过**真实控制器**启动一次执行（不绕过状态机与环境登记）。 */
async function startExecution(
  runtime: Awaited<ReturnType<typeof createApplicationRuntime>>,
): Promise<string> {
  runtime.executionEnvironmentRegistry.register({
    environmentIdentifier: "test-env",
    toolchainVersion: "test-1",
    executableIdentifiers: { node: "node" },
    allowedInputProjectRelativePrefixes: ["docs/"],
    allowedOutputProjectRelativePrefixes: ["out/"],
    resourcePolicy: {
      maximumCpuMilliseconds: 10_000,
      maximumMemoryBytes: 128 * 1024 * 1024,
      maximumProcessCount: 4,
      maximumDiskBytes: 16 * 1024 * 1024,
    },
    isNetworkAllowed: false,
  });
  const started = await runtime.processExecutionController.start({
    ownership: {
      projectIdentifier: "project-a",
      agentInstanceIdentifier: "main-agent-1",
      missionIdentifier: null,
      taskIdentifier: "task-1",
      attemptNumber: 1,
      authorizationRevision: 1,
    },
    request: {
      environmentIdentifier: "test-env",
      executableIdentifier: "node",
      arguments: ["-e", "console.log(1)"],
      workingDirectory: "docs",
    },
  });
  return started.executionId;
}

async function buildRuntime(outputText: string) {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
    sandboxExecutionBackend: buildTestBackend(outputText),
  });
}

describe("EXEC-01-04 SDK 执行控制面", () => {
  it("输出读取在返回前脱敏（密钥不得交给调用方）", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const runtime = await buildRuntime(`输出里有 ${secret}`);
    const facade = new AstarrayApplicationFacade(runtime);
    try {
      const session = await facade.createSession({
        sessionId: "session-exec-sdk",
        mode: "assist",
      });
      const executionId = await startExecution(runtime);
      const output = await facade.readProcessExecutionOutput({
        sessionId: session.sessionId,
        executionId,
        stream: "stdout",
        fromCursorBytes: 0,
      });
      expect(output.outputText).toContain("[REDACTED]");
      expect(output.outputText).not.toContain(secret);
      expect(output.nextCursorBytes).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("取消后状态可查，且状态为 cancelled（状态视图不含后端句柄）", async () => {
    const runtime = await buildRuntime("运行中");
    const facade = new AstarrayApplicationFacade(runtime);
    try {
      const session = await facade.createSession({
        sessionId: "session-exec-cancel",
        mode: "assist",
      });
      const executionId = await startExecution(runtime);
      const cancelled = await facade.cancelProcessExecution({
        sessionId: session.sessionId,
        executionId,
        reason: "调用方取消",
      });
      expect(cancelled.status).toBe("cancelled");
      const status = await facade.queryProcessExecution({
        sessionId: session.sessionId,
        executionId,
      });
      expect(status.status).toBe("cancelled");
      expect(JSON.stringify(status)).not.toContain("handle-");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("未知执行 ⇒ 公开错误（不泄漏内部细节）", async () => {
    const runtime = await buildRuntime("x");
    const facade = new AstarrayApplicationFacade(runtime);
    try {
      const session = await facade.createSession({
        sessionId: "session-exec-missing",
        mode: "assist",
      });
      await expect(
        facade.queryProcessExecution({
          sessionId: session.sessionId,
          executionId: "execution-does-not-exist",
        }),
      ).rejects.toThrow(/execution|执行/u);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
