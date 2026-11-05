/**
 * 启动自动恢复 Phase 4（2026-11-05）：公开 facade 透传策略与启动触发。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import { DEFAULT_STARTUP_RECOVERY_POLICY } from "../../../packages/core/src/orchestration/startup-recovery-policy.js";
import { StartupRecoveryReportStore } from "../../../packages/core/src/orchestration/startup-recovery-report.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("启动恢复 facade 透传", () => {
  it("facade 选项透传策略与启动触发，并落启动报告", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-startup-facade-"));
    directories.push(stateDirectory);
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      isStartupRecoveryOnBootEnabled: true,
      startupRecoveryPolicy: {
        ...DEFAULT_STARTUP_RECOVERY_POLICY,
        isEnabled: true,
        startupDelayMilliseconds: 10,
      },
    });
    try {
      const store = new StartupRecoveryReportStore({ baseDirectory: stateDirectory });
      const deadline = Date.now() + 5_000;
      let report = await store.readReport();
      while (report === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        report = await store.readReport();
      }
      expect(report).not.toBeNull();
      expect(report?.scan.policy.isEnabled).toBe(true);
      expect(report?.run.resumed).toEqual([]);
    } finally {
      await application.shutdown().catch(() => undefined);
    }
  });
});
