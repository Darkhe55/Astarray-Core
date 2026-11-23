/**
 * D5 / EXEC-01-03（2026-11-23）：**完整流扫描**的反例。
 *
 * 旧路径只做单块 `redactSensitiveText`（覆盖 sk-/ghp_ 等少数模式）：
 * `Authorization: Bearer …`、PEM 私钥、连接串密码会被**原样交出**。
 * 新路径在 `block` 策略下把本流已读内容累积后整体做四态扫描，非 clean 即不释放。
 */
import { describe, expect, it } from "vitest";

import {
  ExecutionEnvironmentRegistry,
  type ExecutionEnvironmentPolicy,
} from "../../../packages/core/src/execution/execution-contract.js";
import {
  InMemoryProcessExecutionStore,
  ProcessExecutionController,
} from "../../../packages/core/src/execution/process-execution-controller.js";
import type {
  SandboxExecutionBackend,
  SandboxOutputStreamChunk,
} from "../../../packages/core/src/execution/process-execution-controller.js";

const ENVIRONMENT_POLICY: ExecutionEnvironmentPolicy = {
  environmentIdentifier: "whole-stream-env",
  toolchainVersion: "test-1",
  executableIdentifiers: { node: "node" },
  allowedInputProjectRelativePrefixes: ["docs/"],
  allowedOutputProjectRelativePrefixes: ["out/"],
  resourcePolicy: {
    maximumCpuMilliseconds: 5_000,
    maximumMemoryBytes: 64 * 1024 * 1024,
    maximumProcessCount: 2,
    maximumDiskBytes: 8 * 1024 * 1024,
  },
  isNetworkAllowed: false,
};

function backendOf(chunks: string[]): SandboxExecutionBackend {
  let index = 0;
  return {
    backendIdentifier: "fake",
    probeCapability: async () => ({ isAvailable: true }),
    start: async () => ({ backendExecutionHandle: "handle-1" }),
    readOutputStream: async (): Promise<SandboxOutputStreamChunk> => {
      const text = chunks[index] ?? "";
      index += 1;
      return {
        text,
        nextCursorBytes: Buffer.byteLength(chunks.slice(0, index).join(""), "utf8"),
        isTruncated: false,
      };
    },
    cancel: async () => ({ status: "cancelled", exitCode: null, failureReason: "取消" }),
  } as never;
}

async function readOnce(chunks: string[], overrides: Record<string, unknown> = {}) {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(ENVIRONMENT_POLICY);
  const controller = new ProcessExecutionController({
    environmentRegistry: registry,
    store: new InMemoryProcessExecutionStore(),
    sandboxBackend: backendOf(chunks),
    ...overrides,
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
      environmentIdentifier: "whole-stream-env",
      executableIdentifier: "node",
      arguments: ["-e", "1"],
      workingDirectory: "docs",
    },
  });
  return controller.readOutput({
    requestingAgentInstanceIdentifier: "agent-1",
    executionId: started.executionId,
    stream: "stdout",
    fromCursorBytes: 0,
  });
}

describe("D5：完整流扫描", () => {
  it("① Authorization 头（单块脱敏覆盖不到）⇒ 阻断且不释放", async () => {
    await expect(
      readOnce(["curl -H 'Authorization: Bearer abcdefghijklmnop123456'\n"]),
    ).rejects.toMatchObject({ errorCode: "execution-output-scan-blocked" });
  });

  it("② PEM 私钥 ⇒ 阻断且不释放", async () => {
    await expect(
      readOnce(["-----BEGIN RSA PRIVATE KEY-----\nMIIEow…\n-----END RSA PRIVATE KEY-----\n"]),
    ).rejects.toMatchObject({ errorCode: "execution-output-scan-blocked" });
  });

  it("③ 秘密被切到两次读取（累积后才命中）⇒ 第二次读取阻断", async () => {
    const registry = new ExecutionEnvironmentRegistry();
    registry.register(ENVIRONMENT_POLICY);
    const controller = new ProcessExecutionController({
      environmentRegistry: registry,
      store: new InMemoryProcessExecutionStore(),
      sandboxBackend: backendOf(["token=", "sk-abcdefghijklmnop1234567890\n"]),
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
        environmentIdentifier: "whole-stream-env",
        executableIdentifier: "node",
        arguments: ["-e", "1"],
        workingDirectory: "docs",
      },
    });
    const first = await controller.readOutput({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId: started.executionId,
      stream: "stdout",
      fromCursorBytes: 0,
    });
    expect(first.text).toBe("token=");
    await expect(
      controller.readOutput({
        requestingAgentInstanceIdentifier: "agent-1",
        executionId: started.executionId,
        stream: "stdout",
        fromCursorBytes: first.nextCursorBytes,
      }),
    ).rejects.toMatchObject({ errorCode: "execution-output-scan-blocked" });
  });

  it("④ 普通输出 ⇒ 原样返回", async () => {
    const output = await readOnce(["编译完成，耗时 1.2s\n"]);
    expect(output.text).toBe("编译完成，耗时 1.2s\n");
  });

  it("⑤ 超过完整扫描预算 ⇒ 阻断（不当作扫完）", async () => {
    const big = "普通文本。".repeat(200_000);
    await expect(
      readOnce([big], { outputScanAccumulatorMaximumBytes: 1_000 }),
    ).rejects.toMatchObject({ errorCode: "execution-output-scan-blocked" });
  });
});
