/**
 * E2（2026-11-25）：弱隔离的产品入口约束。
 *
 * 反例：只开弱档、不开自动探测 ⇒ 必须**提前拒绝**（否则后端为 null，用户误以为已启用）。
 * 正例：两者同开 + 强制弱档 ⇒ 装配成功（不执行任何任务）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sdk-weak-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("E2 弱隔离产品入口", () => {
  it("① 只开弱档、不开自动探测 ⇒ invalid-arguments（不静默降级）", async () => {
    await expect(
      AstarrayApplicationFacade.create({
        stateDirectory,
        mode: "assist",
        runtime: "mock",
        isSandboxWeakIsolationEnabled: true,
      }),
    ).rejects.toMatchObject({ errorCode: "invalid-arguments" });
  });

  it("② 自动探测 + 弱档 + 强制弱档 ⇒ 装配成功（不执行任务）", async () => {
    const facade = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
      isSandboxBackendAutoDetected: true,
      isSandboxWeakIsolationEnabled: true,
      isSandboxWeakIsolationForced: true,
      sandboxApplicationRootPath: process.cwd(),
    });
    await facade.shutdown().catch(() => undefined);
  });
});
