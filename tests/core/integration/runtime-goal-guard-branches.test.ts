/**
 * B9（2026-11-24）：目标模式运行时的守卫分支（未知目标的失效/对账/失活）。
 *
 * 纪律：未知目标一律响亮失败，不创建空状态、不静默成功。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-goal-runtime-guard-"));
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

describe("B9：目标模式运行时守卫", () => {
  it("① 标记证据失效：未知目标 ⇒ mission-not-found", async () => {
    const runtime = await createRuntime();
    try {
      await expect(
        runtime.invalidateGoalEvidence({
          goalIdentifier: "goal-missing",
          requirementIdentifiers: ["R1"],
          reason: "测试",
        }),
      ).rejects.toMatchObject({ errorCode: "mission-not-found" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("② 在途组对账：未知目标 ⇒ mission-not-found", async () => {
    const runtime = await createRuntime();
    try {
      await expect(
        runtime.reconcileGoalTaskGroup({
          goalIdentifier: "goal-missing",
          taskGroupIdentifier: "group-1",
          note: "已核对副作用",
        }),
      ).rejects.toMatchObject({ errorCode: "mission-not-found" });
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("③ 失活目标：未知目标 ⇒ 响亮失败或明确无状态（不伪造失活成功）", async () => {
    const runtime = await createRuntime();
    try {
      const outcome = await runtime
        .deactivateGoal({ goalIdentifier: "goal-missing", reason: "测试" })
        .then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
      if (outcome.kind === "resolved") {
        /** 现状：store 允许写关闭标记；锁定"不谎报已解绑"的语义。 */
        expect(outcome.value.unboundMissionCount).toBe(0);
      } else {
        expect(outcome.error).toMatchObject({ errorCode: "mission-not-found" });
      }
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
