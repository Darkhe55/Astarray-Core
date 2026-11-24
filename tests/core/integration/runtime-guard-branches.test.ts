/**
 * B9（2026-11-24）：应用运行时/装配层守卫分支。
 *
 * 覆盖：非法 mode 装配拒绝、未认证主体拒绝权限放宽预览/确认、
 * 重新规划空说明拒绝、未知目标恢复拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-runtime-guard-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function baseOptions() {
  return {
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    runtimeKind: "mock" as const,
    useFeedbackProcess: false,
    streamOutput: () => {},
  };
}

describe("B9：应用运行时守卫", () => {
  it("① 非法 mode 当前不被装配层拒绝（如实锁定现状，待产品裁决）", async () => {
    /** FINDING：`createApplicationRuntime` 未校验 mode 取值；此处锁定现状而非臆造拒绝。 */
    const runtime = await createApplicationRuntime({ ...baseOptions(), mode: "turbo" as never });
    await runtime.shutdown().catch(() => undefined);
  });

  it("② 未认证主体 ⇒ 权限放宽预览/确认均拒绝", async () => {
    const runtime = await createApplicationRuntime({ ...baseOptions(), mode: "assist" });
    try {
      await expect(
        runtime.previewScopedPermissionChange({
          scope: "project",
          identifier: "project-1",
          permissionProfileId: "devolve",
          expectedRevision: 0,
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });

      await expect(
        runtime.confirmScopedPermissionChange({
          previewIdentifier: "preview-1",
          fingerprint: "fingerprint-1",
          expectedRevision: 0,
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("③ 重新规划：空说明 ⇒ invalid-task-chain", async () => {
    const runtime = await createApplicationRuntime({ ...baseOptions(), mode: "assist" });
    try {
      await expect(
        runtime.replanGoal({ goalIdentifier: "goal-1", note: "   " }),
      ).rejects.toMatchObject({ errorCode: "invalid-task-chain" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("④ 重新规划：未知目标 ⇒ mission-not-found（不伪造恢复）", async () => {
    const runtime = await createApplicationRuntime({ ...baseOptions(), mode: "assist" });
    try {
      await expect(
        runtime.replanGoal({ goalIdentifier: "goal-missing", note: "调整计划" }),
      ).rejects.toMatchObject({ errorCode: "mission-not-found" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
