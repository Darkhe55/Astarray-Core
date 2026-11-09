/**
 * EXEC-01-02（2026-11-09）：**产品入口**必须显式开启沙箱后端探测。
 *
 * 为什么单独守一条：装配层默认关闭探测（避免测试付出子进程代价），
 * 因此"产品入口有没有打开它"是一个**容易漏掉**的接线点 ——
 * 漏掉就等于受控执行在产品里永远报"未装配"，而测试全绿。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapCli } from "../../../packages/tui/src/cli/bootstrap.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-bootstrap-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

describe("EXEC-01-02 CLI 引导接线", () => {
  it("引导后的运行时**已开启**后端探测（不依赖调用方再传一次）", async () => {
    const runtime = await bootstrapCli({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 2,
      useFeedbackProcess: false,
      streamOutput: () => {},
    });
    try {
      /**
       * 可观测证据：装配了后端时，`start` 的拒绝原因来自**探测**
       * （"没有可用的隔离执行后端：…"）；未装配时是"未装配"。
       * 这里只断言"不是未装配"，避免依赖本机是否恰好有组件。
       */
      runtime.executionEnvironmentRegistry.register({
        environmentIdentifier: "cli-env",
        toolchainVersion: "cli-1",
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
      const message = await runtime.processExecutionController
        .start({
          ownership: {
            projectIdentifier: "project-a",
            agentInstanceIdentifier: "main-agent-1",
            missionIdentifier: null,
            taskIdentifier: "task-1",
            attemptNumber: 1,
            authorizationRevision: 1,
          },
          request: {
            environmentIdentifier: "cli-env",
            executableIdentifier: "node",
            arguments: ["-e", "1"],
            workingDirectory: "docs",
          },
        })
        .then(() => "started")
        .catch((error: unknown) => (error as Error).message);
      expect(message).not.toBe("started");
      expect(message).not.toContain("未装配");
      expect(message).toContain("没有可用的隔离执行后端");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
