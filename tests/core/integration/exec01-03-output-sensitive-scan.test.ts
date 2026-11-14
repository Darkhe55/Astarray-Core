/**
 * EXEC-01-03（2026-11-09）：**返回输出前的敏感扫描门禁**。
 *
 * 卡内要求：受控执行的输出在**离开控制器之前**完成敏感内容处理，
 * 不能只在某一个消费方（例如 SDK 或 UI）遮挡 —— 那样另一条通路就照原样外泄。
 *
 * 本文件钉住：控制器自身返回的就是**已脱敏**文本，并如实回报"是否发生替换"。
 */
import { describe, expect, it } from "vitest";

import { ProcessExecutionController } from "../../../packages/core/src/execution/process-execution-controller.js";
import {
  ExecutionEnvironmentRegistry,
  type ExecutionEnvironmentPolicy,
} from "../../../packages/core/src/execution/execution-contract.js";
import { InMemoryProcessExecutionStore } from "../../../packages/core/src/execution/process-execution-controller.js";
import type {
  SandboxCapabilityProfile,
  SandboxExecutionBackend,
  SandboxExecutionSnapshot,
  SandboxOutputStreamChunk,
  SandboxStartOutcome,
} from "../../../packages/core/src/execution/process-execution-controller.js";

const ENVIRONMENT_POLICY: ExecutionEnvironmentPolicy = {
  environmentIdentifier: "scan-env",
  toolchainVersion: "scan-1",
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

function buildBackend(text: string): SandboxExecutionBackend {
  return {
    async probeCapability(): Promise<SandboxCapabilityProfile> {
      return {
        isAvailable: true,
        backendIdentifier: "scan-test-backend",
        isolationPrimitiveDescription: "测试后端（非真实隔离）",
        reasonUnavailable: null,
      };
    },
    async start(): Promise<SandboxStartOutcome> {
      return { backendExecutionHandle: "handle-scan", status: "running" };
    },
    async readStatus(): Promise<SandboxExecutionSnapshot> {
      return { status: "running", exitCode: null, failureReason: null };
    },
    async readOutputStream(): Promise<SandboxOutputStreamChunk> {
      return { text, nextCursorBytes: Buffer.byteLength(text, "utf8"), isTruncated: false };
    },
    async cancel(): Promise<SandboxExecutionSnapshot> {
      return { status: "cancelled", exitCode: null, failureReason: "取消" };
    },
  };
}

async function startAndRead(text: string) {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(ENVIRONMENT_POLICY);
  const controller = new ProcessExecutionController({
    environmentRegistry: registry,
    store: new InMemoryProcessExecutionStore(),
    sandboxBackend: buildBackend(text),
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
      arguments: ["-e", "console.log(1)"],
      workingDirectory: "docs",
    },
  });
  return await controller.readOutput({
    requestingAgentInstanceIdentifier: "agent-1",
    executionId: started.executionId,
    stream: "stdout",
    fromCursorBytes: 0,
  });
}

describe("EXEC-01-03 输出敏感扫描门禁", () => {
  it("输出含 API key ⇒ 控制器返回的文本已脱敏，并如实标记", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const output = await startAndRead(`stdout: token=${secret}\n`);
    expect(output.text).not.toContain(secret);
    expect(output.text).toContain("[REDACTED]");
    expect(output.isSensitiveContentRedacted).toBe(true);
  }, 30_000);

  it("GitHub token 同样被遮挡（不只 sk- 前缀）", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const output = await startAndRead(`push failed: ${secret}\n`);
    expect(output.text).not.toContain(secret);
    expect(output.isSensitiveContentRedacted).toBe(true);
  }, 30_000);

  it("普通输出不被改写，且标记为未替换（区分「没发现」与「没扫描」）", async () => {
    const output = await startAndRead("编译完成，耗时 1.2s\n");
    expect(output.text).toBe("编译完成，耗时 1.2s\n");
    expect(output.isSensitiveContentRedacted).toBe(false);
  }, 30_000);

  it("游标与截断标记不受脱敏影响（不得因脱敏而错位）", async () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const rawText = `前缀 ${secret} 后缀`;
    const output = await startAndRead(rawText);
    expect(output.nextCursorBytes).toBe(Buffer.byteLength(rawText, "utf8"));
    expect(output.isTruncated).toBe(false);
  }, 30_000);
});

/**
 * EXEC-01-03（2026-11-14）：**跨块**敏感扫描。
 *
 * 卡内要求"敏感模式跨块匹配，不能先发送秘密片段再补扫描"。
 * 下面两个用例把同一个秘密切在两次读取的边界上：
 * 开启边界暂扣后，前半段**不得**先外发；关闭时（默认）则该风险如实保留。
 */
function buildCursorBackend(fullText: string): SandboxExecutionBackend {
  return {
    async probeCapability(): Promise<SandboxCapabilityProfile> {
      return {
        isAvailable: true,
        backendIdentifier: "scan-cursor-backend",
        isolationPrimitiveDescription: "测试后端（非真实隔离）",
        reasonUnavailable: null,
      };
    },
    async start(): Promise<SandboxStartOutcome> {
      return { backendExecutionHandle: "handle-cursor", status: "running" };
    },
    async readStatus(): Promise<SandboxExecutionSnapshot> {
      return { status: "running", exitCode: null, failureReason: null };
    },
    async readOutputStream(chunkRequest: {
      readonly fromCursorBytes: number;
      readonly maximumBytes: number;
    }): Promise<SandboxOutputStreamChunk> {
      const allBytes = Buffer.from(fullText, "utf8");
      const start = Math.min(chunkRequest.fromCursorBytes, allBytes.length);
      const end = Math.min(start + chunkRequest.maximumBytes, allBytes.length);
      return {
        text: allBytes.subarray(start, end).toString("utf8"),
        nextCursorBytes: end,
        isTruncated: false,
      };
    },
    async cancel(): Promise<SandboxExecutionSnapshot> {
      return { status: "cancelled", exitCode: null, failureReason: "取消" };
    },
  };
}

async function readAllChunks(input: {
  readonly fullText: string;
  readonly maximumBytes: number;
  readonly boundaryCarryCharacters?: number;
}): Promise<{ text: string; redactedAny: boolean }> {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(ENVIRONMENT_POLICY);
  const controller = new ProcessExecutionController({
    environmentRegistry: registry,
    store: new InMemoryProcessExecutionStore(),
    sandboxBackend: buildCursorBackend(input.fullText),
    ...(input.boundaryCarryCharacters === undefined
      ? {}
      : { outputScanBoundaryCarryCharacters: input.boundaryCarryCharacters }),
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
      arguments: ["-e", "console.log(1)"],
      workingDirectory: "docs",
    },
  });
  const totalBytes = Buffer.byteLength(input.fullText, "utf8");
  let cursor = 0;
  let collected = "";
  let redactedAny = false;
  for (let round = 0; round < 32 && cursor < totalBytes; round += 1) {
    const chunk = await controller.readOutput({
      requestingAgentInstanceIdentifier: "agent-1",
      executionId: started.executionId,
      stream: "stdout",
      fromCursorBytes: cursor,
      maximumBytes: input.maximumBytes,
    });
    collected += chunk.text;
    redactedAny = redactedAny || chunk.isSensitiveContentRedacted;
    if (chunk.nextCursorBytes <= cursor) {
      break;
    }
    cursor = chunk.nextCursorBytes;
  }
  return { text: collected, redactedAny };
}

describe("EXEC-01-03 跨块敏感扫描", () => {
  it("秘密被切在两次读取之间 ⇒ 开启暂扣后不泄漏前半段", async () => {
    const secret = "sk-zzzzzzzzzzzzzzzzzzzzzzzz";
    const fullText = `token=${secret}\n`;
    const result = await readAllChunks({
      fullText,
      maximumBytes: 10,
      boundaryCarryCharacters: 32,
    });
    expect(result.redactedAny).toBe(true);
    expect(result.text).not.toContain(secret.slice(0, 8));
    expect(result.text).not.toContain(secret);
  }, 30_000);


});
