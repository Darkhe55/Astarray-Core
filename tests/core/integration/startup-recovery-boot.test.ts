/**
 * 启动自动恢复 Phase 4（2026-11-05）：启动自动触发 + 持久化启动报告。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { DEFAULT_STARTUP_RECOVERY_POLICY } from "../../../packages/core/src/orchestration/startup-recovery-policy.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("启动自动恢复启动触发", () => {
  it("开启后延迟执行并落 last-report.json；默认关闭时不触发", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-startup-boot-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
      isStartupRecoveryOnBootEnabled: true,
      startupRecoveryPolicy: {
        ...DEFAULT_STARTUP_RECOVERY_POLICY,
        isEnabled: true,
        startupDelayMilliseconds: 10,
      },
    });
    try {
      const deadline = Date.now() + 5_000;
      let report = await runtime.readStartupRecoveryReport();
      while (report === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        report = await runtime.readStartupRecoveryReport();
      }
      expect(report).not.toBeNull();
      expect(report?.schemaVersion).toBe(1);
      expect(report?.scan.policy.isEnabled).toBe(true);
      expect(report?.run.resumed).toEqual([]);
      expect(typeof report?.generatedAtIso).toBe("string");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("未开启启动触发时不会自动写报告", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-startup-boot2-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
      startupRecoveryPolicy: {
        ...DEFAULT_STARTUP_RECOVERY_POLICY,
        isEnabled: true,
        startupDelayMilliseconds: 10,
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await runtime.readStartupRecoveryReport()).toBeNull();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
