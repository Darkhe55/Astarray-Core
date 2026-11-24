/**
 * E2 弱档真实验收（2026-11-25，Windows）。
 *
 * 只在 helper 已构建时运行；用 `isWeakIsolationForced` 跳过强档探测
 * （强档"探测通过但普通会话建不了进程"是已知平台事实）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlatformSandboxExecutionBackend } from "../../../packages/core/src/execution/platform-sandbox-backend.js";
import type { SandboxExecutionSnapshot } from "../../../packages/core/src/execution/process-execution-controller.js";
import { buildProcessExecutionIdentity } from "../../../packages/core/src/execution/execution-contract.js";

vi.setConfig({ testTimeout: 120_000 });

const helperPath = path.join(process.cwd(), "native", "sandbox-helper", "sandbox-helper.exe");
const isAcceptanceHost =
  process.platform === "win32" &&
  existsSync(helperPath) &&
  spawnSync(helperPath, ["probe"], { encoding: "utf8" }).status === 0;

let workingDirectory: string;

beforeAll(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-weak-acceptance-"));
});

afterAll(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function identity(input: { executionId: string; taskIdentifier: string; argumentsList: string[] }) {
  return buildProcessExecutionIdentity({
    ownership: {
      projectIdentifier: "project-local",
      agentInstanceIdentifier: "main-agent-local",
      missionIdentifier: null,
      taskIdentifier: input.taskIdentifier,
      attemptNumber: 1,
      authorizationRevision: 1,
    },
    request: {
      environmentIdentifier: "weak-env",
      executableIdentifier: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\cmd.exe` : "cmd.exe",
      arguments: input.argumentsList,
      workingDirectory: workingDirectory,
    },
    environmentFingerprint: "sha256:weak",
    generateExecutionId: () => input.executionId,
  });
}

async function waitForTerminal(
  backend: NonNullable<ReturnType<typeof createPlatformSandboxExecutionBackend>>,
  handle: string,
): Promise<SandboxExecutionSnapshot> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshot = await backend.readStatus(handle);
    if (snapshot.status !== "running") return snapshot;
    if (Date.now() > deadline) throw new Error("等待弱档终态超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!isAcceptanceHost)("E2 弱档真实验收", () => {
  const commandPath = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\cmd.exe`
    : "C:\\Windows\\System32\\cmd.exe";

  it("① 弱档能力可用（显式 forced）且标识为 weak", async () => {
    const backend = createPlatformSandboxExecutionBackend({
      applicationRootPath: process.cwd(),
      isWeakIsolationAllowed: true,
      isWeakIsolationForced: true,
    });
    expect(backend).not.toBeNull();
    if (backend === null) return;
    const capability = await backend.probeCapability();
    expect(capability.isAvailable).toBe(true);
    expect(capability.backendIdentifier).toBe("sandbox-helper-weak");
  });

  it("② 真实执行成功；③ 写用户主目录被拒", async () => {
    const backend = createPlatformSandboxExecutionBackend({
      applicationRootPath: process.cwd(),
      isWeakIsolationAllowed: true,
      isWeakIsolationForced: true,
    });
    if (backend === null) throw new Error("backend 为空");
    await backend.probeCapability();

    const okRun = await backend.start({
      identity: identity({
        executionId: "weak-ok",
        taskIdentifier: "weak-ok",
        argumentsList: ["/c", "echo weak-ok"],
      }),
      executableEntryPoint: commandPath,
      arguments: ["/c", "echo weak-ok"],
      workingDirectory,
      timeoutMilliseconds: 20_000,
      streamStorageLimitBytes: 64 * 1024,
      resourceLimits: { maximumMemoryBytes: 512 * 1024 * 1024, maximumProcessCount: 8 },
    });
    const okTerminal = await waitForTerminal(backend, okRun.backendExecutionHandle);
    expect(okTerminal.status).toBe("succeeded");
    const stdout = await backend.readOutputStream({
      backendExecutionHandle: okRun.backendExecutionHandle,
      stream: "stdout",
      fromCursorBytes: 0,
      maximumBytes: 64 * 1024,
    });
    expect(stdout.text).toContain("weak-ok");

    const deniedRun = await backend.start({
      identity: identity({
        executionId: "weak-write",
        taskIdentifier: "weak-write",
        argumentsList: ["/c", "echo x > %USERPROFILE%\\astarray-weak-write.txt"],
      }),
      executableEntryPoint: commandPath,
      arguments: ["/c", "echo x > %USERPROFILE%\\astarray-weak-write.txt"],
      workingDirectory,
      timeoutMilliseconds: 20_000,
      streamStorageLimitBytes: 64 * 1024,
      resourceLimits: { maximumMemoryBytes: 512 * 1024 * 1024, maximumProcessCount: 8 },
    });
    const deniedTerminal = await waitForTerminal(backend, deniedRun.backendExecutionHandle);
    expect(deniedTerminal.status).not.toBe("succeeded");
    const targetPath = process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "astarray-weak-write.txt")
      : null;
    if (targetPath !== null) {
      await expect(fs.access(targetPath)).rejects.toThrow();
    }
  });
});