/**
 * D5（2026-11-23 产品裁决）：模型可见执行输出默认 **block**——
 * 完整扫描得到 clean 之后才交出正文；敏感/未判定内容一律不释放。
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
  environmentIdentifier: "scan-env",
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

function backendFor(text: string): SandboxExecutionBackend {
  return {
    backendIdentifier: "fake",
    probeCapability: async () => ({ isAvailable: true }),
    start: async () => ({ backendExecutionHandle: "handle-1" }),
    readOutputStream: async (): Promise<SandboxOutputStreamChunk> => ({
      text,
      nextCursorBytes: Buffer.byteLength(text, "utf8"),
      isTruncated: false,
    }),
    cancel: async () => ({ status: "cancelled", exitCode: null, failureReason: "取消" }),
  } as never;
}

async function readOutput(text: string) {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(ENVIRONMENT_POLICY);
  const controller = new ProcessExecutionController({
    environmentRegistry: registry,
    store: new InMemoryProcessExecutionStore(),
    sandboxBackend: backendFor(text),
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
      environmentIdentifier: "scan-env",
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

describe("D5：模型可见输出的 block 策略", () => {
  it("① 含敏感内容 ⇒ 不释放正文（block）", async () => {
    await expect(
      readOutput("token=sk-abcdefghijklmnop1234567890\n"),
    ).rejects.toMatchObject({ errorCode: "execution-output-scan-blocked" });
  });

  it("② 普通输出 ⇒ 原样放出", async () => {
    const output = await readOutput("编译完成，耗时 1.2s\n");
    expect(output.text).toBe("编译完成，耗时 1.2s\n");
  });

  it("③ 拒绝时错误信息不含原文（诊断不二次泄漏）", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    await expect(readOutput(`token=${secret}\n`)).rejects.toSatisfy(
      (error: { message: string }) => !error.message.includes(secret),
    );
  });
});
