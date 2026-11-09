/**
 * EXEC-01-02（2026-11-09）：**按平台自动探测后端**在真实装配里的行为。
 *
 * 三条纪律：
 *  1. 缺省**不**自动探测（不让每个 runtime 都启动子进程）；
 *  2. 开启且找到组件 ⇒ 装配后端；探测不可用 ⇒ `start` 仍拒绝（**不降级到宿主执行**）；
 *  3. 开启但找不到组件 ⇒ 后端为 `null`，拒绝原因如实说"未装配"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;
let helperRootPath: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-autodetect-"));
  helperRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-autodetect-root-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
  await fs.rm(helperRootPath, { recursive: true, force: true, maxRetries: 10 });
});

/** 启动一次受控执行并返回拒绝原因（不关心成功路径）。 */
async function startAndCatch(input: {
  readonly isAutoDetected: boolean;
  readonly helperExecutablePathOverride?: string;
}): Promise<string> {
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
    isSandboxBackendAutoDetected: input.isAutoDetected,
    sandboxApplicationRootPath: helperRootPath,
    ...(input.helperExecutablePathOverride === undefined
      ? {}
      : { sandboxHelperExecutablePathOverride: input.helperExecutablePathOverride }),
  });
  try {
    runtime.executionEnvironmentRegistry.register({
      environmentIdentifier: "auto-env",
      toolchainVersion: "auto-1",
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
    });
    await runtime.processExecutionController.start({
      ownership: {
        projectIdentifier: "project-a",
        agentInstanceIdentifier: "main-agent-1",
        missionIdentifier: null,
        taskIdentifier: "task-1",
        attemptNumber: 1,
        authorizationRevision: 1,
      },
      request: {
        environmentIdentifier: "auto-env",
        executableIdentifier: "node",
        arguments: ["-e", "1"],
        workingDirectory: "docs",
      },
    });
    return "started";
  } catch (error) {
    return (error as Error).message;
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("EXEC-01-02 平台后端自动探测", () => {
  it("缺省不探测 ⇒ 拒绝原因为「未装配」（不启动子进程）", async () => {
    const message = await startAndCatch({ isAutoDetected: false });
    expect(message).toContain("未装配");
  }, 60_000);

  it("开启探测但本机无组件 ⇒ 仍拒绝，原因同样如实", async () => {
    const message = await startAndCatch({ isAutoDetected: true });
    expect(message).toMatch(/未装配|不可用/u);
  }, 60_000);

  it("开启探测且组件存在 ⇒ 装配后端并**探测后拒绝**（不降级到宿主执行）", async () => {
    /** 空文件：能被解析为"存在"，但探测不会给出成功标记 ⇒ 必须判不可用。 */
    const helperPath = path.join(helperRootPath, "helper.exe");
    await fs.writeFile(helperPath, "", "utf8");
    const message = await startAndCatch({
      isAutoDetected: true,
      helperExecutablePathOverride: helperPath,
    });
    /**
     * 关键：拒绝原因来自**后端探测**（"没有可用的隔离执行后端：辅助程序…"），
     * 而不是"未装配"。空文件在 Windows 上表现为 `spawn EFTYPE`，
     * 因此这里断言"辅助程序无法启动"这条真实原因，而不是某句固定文案。
     */
    expect(message).toContain("没有可用的隔离执行后端");
    expect(message).toContain("辅助程序");
    expect(message).not.toContain("started");
  }, 60_000);
});
