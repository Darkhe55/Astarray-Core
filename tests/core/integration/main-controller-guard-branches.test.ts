/**
 * B9（2026-11-24）：主控制器守卫分支（未知 mission 的续接/取消/状态查询）。
 *
 * 纪律：未知 mission 一律**响亮失败**，不返回空壳状态、不伪造取消成功。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-controller-guard-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createRuntime() {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    streamOutput: () => {},
  });
}

describe("B9：主控制器未知 mission 守卫", () => {
  it("① 续接未知 mission ⇒ mission-not-found（不伪造恢复）", async () => {
    const runtime = await createRuntime();
    try {
      await expect(
        runtime.controller.resumeMission("mission-missing"),
      ).rejects.toMatchObject({ errorCode: "mission-not-found" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("② 取消未知 mission ⇒ 幂等成功（无事可取消，不写终态）", async () => {
    const runtime = await createRuntime();
    try {
      await expect(runtime.controller.cancelMission("mission-missing")).resolves.toBeUndefined();
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("③ 查询未知 mission 状态 ⇒ mission-not-found（不返回空壳）", async () => {
    const runtime = await createRuntime();
    try {
      await expect(
        runtime.controller.queryMissionStatus("mission-missing"),
      ).rejects.toMatchObject({ errorCode: "mission-not-found" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
