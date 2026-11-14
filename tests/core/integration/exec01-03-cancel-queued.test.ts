/**
 * EXEC-01-03：**排队中的执行必须可取消**（2026-11-14 核实发现的反例）。
 *
 * 卡内 §03 原文：「取消和超时作用于整个隔离执行单元……**任务取消后不启动排队进程**」。
 *
 * 核实前实现：`cancel()` 在 `backendExecutionHandle === null` 时直接抛
 * `execution-backend-unsupported`（"未装配沙箱执行后端：无法取消"）。
 * 也就是说**排队中的执行根本取消不了**——取消只对已经跑起来的进程有效，
 * 排队项随后照样会被启动，"取消后不启动排队进程"这条形同虚设。
 *
 * 本文件先钉住正确行为：排队项的取消必须**落状态**、**不调用后端**、并保留终止原因分类。
 */
import { describe, expect, it, vi } from "vitest";

import {
  ProcessExecutionController,
  InMemoryProcessExecutionStore,
} from "../../../packages/core/src/execution/process-execution-controller.js";
import {
  ExecutionEnvironmentRegistry,
  type ExecutionEnvironmentPolicy,
} from "../../../packages/core/src/execution/execution-contract.js";
import type {
  SandboxExecutionBackend,
  SandboxExecutionSnapshot,
} from "../../../packages/core/src/execution/process-execution-controller.js";

const ENVIRONMENT_POLICY: ExecutionEnvironmentPolicy = {
  environmentIdentifier: "queued-cancel-env",
  toolchainVersion: "queued-cancel-1",
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

/**
 * 后端 `start` 挂起不返回 ⇒ 记录停在 `queued`（没有 backendExecutionHandle），
 * 这正是"排队中执行"的真实形态。
 */
function buildQueuedBackend() {
  const cancel = vi.fn(async (): Promise<SandboxExecutionSnapshot> => ({
    status: "cancelled",
    exitCode: null,
    failureReason: "不应被调用",
  }));
  const backend: SandboxExecutionBackend = {
    async probeCapability() {
      return {
        isAvailable: true,
        backendIdentifier: "queued-test-backend",
        isolationPrimitiveDescription: "测试后端（非真实隔离）",
        reasonUnavailable: null,
      };
    },
    async start() {
      return await new Promise(() => {
        /** 永不 resolve：模拟操作系统排队。 */
      });
    },
    async readStatus() {
      return { status: "queued", exitCode: null, failureReason: null };
    },
    async readOutputStream() {
      return { text: "", nextCursorBytes: 0, isTruncated: false };
    },
    cancel,
  } as SandboxExecutionBackend;
  return { backend, cancel };
}

async function startQueuedExecution(backend: SandboxExecutionBackend) {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(ENVIRONMENT_POLICY);
  const controller = new ProcessExecutionController({
    environmentRegistry: registry,
    store: new InMemoryProcessExecutionStore(),
    sandboxBackend: backend,
    generateExecutionId: () => "execution-queued-1",
  });
  /** start 会 `await` 后端 start；这里不等待其完成，让记录停在 queued。 */
  const startPromise = controller.start({
    ownership: {
      projectIdentifier: "project-a",
      agentInstanceIdentifier: "agent-1",
      missionIdentifier: null,
      taskIdentifier: "task-1",
      attemptNumber: 1,
      authorizationRevision: 1,
    },
    request: {
      environmentIdentifier: "queued-cancel-env",
      executableIdentifier: "node",
      arguments: ["-e", "console.log(1)"],
      workingDirectory: "docs",
    },
  });
  /** 等一个宏任务，确保 queued 记录已写入。 */
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { controller, startPromise };
}

describe("EXEC-01-03 排队中的执行可取消", () => {
  it("排队中（无后端句柄）的取消必须成功并落为 cancelled，且不调用后端 cancel", async () => {
    const { backend, cancel } = buildQueuedBackend();
    const { controller } = await startQueuedExecution(backend);

    const queuedStatus = await controller.readStatus({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId: "execution-queued-1",
    });
    expect(queuedStatus.status).toBe("queued");

    const result = await controller.cancel({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId: "execution-queued-1",
      reason: "用户取消排队中的执行",
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminationKind).toBe("caller-cancelled");
    /** 排队项没有后端句柄 ⇒ 不应调用后端 cancel（调用会抛"句柄不存在"）。 */
    expect(cancel).not.toHaveBeenCalled();

    const cancelledStatus = await controller.readStatus({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId: "execution-queued-1",
    });
    expect(cancelledStatus.status).toBe("cancelled");
  }, 30_000);

  it("权限撤销取消排队项 ⇒ 终止原因记为 authorization-revoked（与调用方取消区分）", async () => {
    const { backend } = buildQueuedBackend();
    const { controller } = await startQueuedExecution(backend);

    const result = await controller.cancel({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId: "execution-queued-1",
      reason: "权限被撤销",
      terminationKind: "authorization-revoked",
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminationKind).toBe("authorization-revoked");
  }, 30_000);
});
