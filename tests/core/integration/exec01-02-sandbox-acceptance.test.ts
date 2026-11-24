/**
 * EXEC-01-02 真实沙箱验收（B3/B5 Windows helper；B6 Linux bubblewrap）。
 *
 * - **Linux**：`bwrap` 可用即运行（bubblewrap 不需要提权；`--unshare-all` 探测通过才算可用）；
 * - **Windows**：仅在 helper 已构建 + 安装期档案存在 + 显式 `ASTARRAY_SANDBOX_ACCEPTANCE=1` 时运行。
 *
 * 验三件事：
 * 1. 真实后端 probeCapability 判定可用；
 * 2. 真实受控执行能跑起来并回传退出码（不是 mock、不是宿主直跑）；
 * 3. 超时由执行层真的终止（状态 timed-out，且很快返回）。
 *
 * 纪律：不写仓库文件、不联网；工作目录用 os.tmpdir() 下的临时目录。
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPlatformSandboxExecutionBackend } from "../../../packages/core/src/execution/platform-sandbox-backend.js";
import type { SandboxExecutionSnapshot } from "../../../packages/core/src/execution/process-execution-controller.js";
import { buildProcessExecutionIdentity } from "../../../packages/core/src/execution/execution-contract.js";

vi.setConfig({ testTimeout: 120_000 });

const helperPath = path.join(process.cwd(), "native", "sandbox-helper", "sandbox-helper.exe");
/**
 * Windows 真实执行还要求**安装期初始化**已做过：`%LOCALAPPDATA%\Packages\<profile>\AC` 存在。
 *
 * 只建了档案注册项、却删掉了 Packages 目录的"陈旧档案"能派生 SID，但 cwd 不可用
 * ⇒ CreateProcessW 返回 5（2026-11-25 实测）。这种环境**跳过真实执行**，不伪造通过。
 *
 * 另外平台事实（2026-11-25 对照实测）：**非提权父进程**创建 AppContainer 子进程会被拒
 * （管理员会话成功、普通会话 Access Denied）。因此 Windows 侧必须显式 opt-in，
 * 避免普通开发机/CI 因环境权限差异把门禁误染红；Linux（bubblewrap）不需要提权，默认可跑。
 */
const profileDirectory =
  process.env.LOCALAPPDATA === undefined
    ? null
    : path.join(process.env.LOCALAPPDATA, "Packages", "astarray-exec", "AC");
const isWindowsAcceptanceHost =
  process.platform === "win32" &&
  existsSync(helperPath) &&
  profileDirectory !== null &&
  existsSync(profileDirectory) &&
  process.env.ASTARRAY_SANDBOX_ACCEPTANCE === "1";

const isLinuxBubblewrapAvailable =
  process.platform === "linux" && spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status === 0;

const isAcceptanceHost = isWindowsAcceptanceHost || isLinuxBubblewrapAvailable;

let workingDirectory: string;

beforeAll(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sandbox-acceptance-"));
});

afterAll(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function acceptanceIdentity(input: {
  readonly executionId: string;
  readonly taskIdentifier: string;
  readonly executableEntryPoint: string;
  readonly argumentsList: readonly string[];
}) {
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
      environmentIdentifier: "acceptance-env",
      executableIdentifier: input.executableEntryPoint,
      arguments: input.argumentsList,
      workingDirectory: workingDirectory,
    },
    environmentFingerprint: "sha256:acceptance",
    generateExecutionId: () => input.executionId,
  });
}

async function waitForTerminal(
  backend: ReturnType<typeof createPlatformSandboxExecutionBackend>,
  handle: string,
  timeoutMilliseconds: number,
): Promise<SandboxExecutionSnapshot> {
  if (backend === null) throw new Error("backend 为空");
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const snapshot = await backend.readStatus(handle);
    if (snapshot.status !== "running") return snapshot;
    if (Date.now() > deadline) throw new Error("等待沙箱终态超时");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!isAcceptanceHost)("EXEC-01-02 真实沙箱验收", () => {
  it("① 探测可用 + 真实执行回传成功（不是宿主直跑）", async () => {
    const backend = createPlatformSandboxExecutionBackend({
      applicationRootPath: process.cwd(),
    });
    expect(backend).not.toBeNull();
    if (backend === null) return;

    const capability = await backend.probeCapability();
    expect(capability.isAvailable).toBe(true);

    const started = await backend.start({
      identity: acceptanceIdentity({
        executionId: "acceptance-exec-1",
        taskIdentifier: "task-acceptance",
        executableEntryPoint: process.execPath,
        argumentsList: ["-e", "process.stdout.write('sandbox-ok')"],
      }),
      executableEntryPoint: process.execPath,
      arguments: ["-e", "process.stdout.write('sandbox-ok')"],
      workingDirectory,
      timeoutMilliseconds: 30_000,
      streamStorageLimitBytes: 64 * 1024,
      resourceLimits: {
        maximumMemoryBytes: 4 * 1024 * 1024 * 1024,
        maximumProcessCount: 16,
      },
    });
    expect(started.status).toBe("running");

    const terminal = await waitForTerminal(backend, started.backendExecutionHandle, 30_000);
    if (terminal.status !== "succeeded") {
      /** 失败时把真实原因带进断言消息（否则只看到 "failed" 无法定位）。 */
      const stderrChunk = await backend.readOutputStream({
        backendExecutionHandle: started.backendExecutionHandle,
        stream: "stderr",
        fromCursorBytes: 0,
        maximumBytes: 64 * 1024,
      });
      throw new Error(
        `沙箱执行未成功：status=${terminal.status} exitCode=${String(terminal.exitCode)} ` +
          `reason=${String(terminal.failureReason)} stderr=${stderrChunk.text}`,
      );
    }
    expect(terminal.status).toBe("succeeded");
    expect(terminal.exitCode).toBe(0);

    const chunk = await backend.readOutputStream({
      backendExecutionHandle: started.backendExecutionHandle,
      stream: "stdout",
      fromCursorBytes: 0,
      maximumBytes: 64 * 1024,
    });
    expect(chunk.text).toContain("sandbox-ok");
  });

  it("② 超时 ⇒ 执行层真的终止并落 timed-out（不靠调用方假装）", async () => {
    const backend = createPlatformSandboxExecutionBackend({
      applicationRootPath: process.cwd(),
    });
    if (backend === null) throw new Error("backend 为空");

    const startedAt = Date.now();
    const started = await backend.start({
      identity: acceptanceIdentity({
        executionId: "acceptance-exec-2",
        taskIdentifier: "task-acceptance-timeout",
        executableEntryPoint: process.execPath,
        argumentsList: ["-e", "setTimeout(()=>{}, 60000)"],
      }),
      executableEntryPoint: process.execPath,
      arguments: ["-e", "setTimeout(()=>{}, 60000)"],
      workingDirectory,
      timeoutMilliseconds: 800,
      streamStorageLimitBytes: 64 * 1024,
      resourceLimits: {
        maximumMemoryBytes: 4 * 1024 * 1024 * 1024,
        maximumProcessCount: 16,
      },
    });

    const terminal = await waitForTerminal(backend, started.backendExecutionHandle, 30_000);
    if (terminal.status !== "timed-out") {
      const stderrChunk = await backend.readOutputStream({
        backendExecutionHandle: started.backendExecutionHandle,
        stream: "stderr",
        fromCursorBytes: 0,
        maximumBytes: 64 * 1024,
      });
      throw new Error(
        `超时未生效：status=${terminal.status} exitCode=${String(terminal.exitCode)} ` +
          `reason=${String(terminal.failureReason)} stderr=${stderrChunk.text}`,
      );
    }
    expect(terminal.status).toBe("timed-out");
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });
});
