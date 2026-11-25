/**
 * B9（2026-11-25）：主控制器深层分支——**跨进程租约占用时拒绝接管**。
 *
 * 覆盖 `resumeMission` 中"租约存在且被其他进程持有 ⇒ mission-locked"的分支：
 * 绝不接管正在运行的 mission（fail-closed）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lease-guard-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function waitForTerminal(
  facade: AstarrayApplicationFacade,
  sessionId: string,
  taskIdentifier: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  let status = "accepted";
  while (Date.now() < deadline && !["done", "failed", "blocked", "cancelled"].includes(status)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (await facade.queryTask({ sessionId, taskIdentifier })).status;
  }
  return status;
}

describe("B9：主控制器租约守卫", () => {
  it("① 其他进程持有活动租约 ⇒ 续接被拒（mission-locked）", async () => {
    const facade = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
    });
    try {
      facade.createSession({ sessionId: "session-1", mode: "assist" });
      const submitted = await facade.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-1",
        prompt: "租约守卫",
      } as never);
      const missionIdentifier = (submitted as { missionIdentifier: string }).missionIdentifier;
      expect(typeof missionIdentifier).toBe("string");
      await waitForTerminal(facade, "session-1", "task-1");

      /** 伪造"另一个进程"持有的活动租约（未来的续期时间 ⇒ 仍活动）。 */
      const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
      await fs.mkdir(missionDirectory, { recursive: true });
      await fs.writeFile(
        path.join(missionDirectory, "mission-lease.json"),
        JSON.stringify({
          schemaVersion: 1,
          leaseRevision: 1,
          missionId: missionIdentifier,
          processInstanceId: "process-other",
          agentInstanceId: null,
          purpose: "resume",
          claimedAtIso: new Date().toISOString(),
          renewsUntilIso: new Date(Date.now() + 60_000).toISOString(),
          claimantDescription: "另一进程",
        }),
        "utf8",
      );

      const secondRuntime = await createApplicationRuntime({
        mode: "assist",
        stateDirectory,
        concurrency: 1,
        failureThreshold: 1,
        maxLoopIterations: 2,
        runtimeKind: "mock",
        useFeedbackProcess: false,
        streamOutput: () => {},
      });
      try {
        await expect(
          secondRuntime.controller.resumeMission(missionIdentifier),
        ).rejects.toMatchObject({ errorCode: "mission-locked" });
      } finally {
        await secondRuntime.shutdown().catch(() => undefined);
      }
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 无租约文件 ⇒ 续接不被租约拦截（走到后续判定）", async () => {
    const facade = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
    });
    try {
      facade.createSession({ sessionId: "session-1", mode: "assist" });
      const submitted = await facade.submitTask({
        sessionId: "session-1",
        taskIdentifier: "task-2",
        prompt: "无租约",
      } as never);
      const missionIdentifier = (submitted as { missionIdentifier: string }).missionIdentifier;
      await waitForTerminal(facade, "session-1", "task-2");

      const secondRuntime = await createApplicationRuntime({
        mode: "assist",
        stateDirectory,
        concurrency: 1,
        failureThreshold: 1,
        maxLoopIterations: 2,
        runtimeKind: "mock",
        useFeedbackProcess: false,
        streamOutput: () => {},
      });
      const outcome = await secondRuntime.controller
        .resumeMission(missionIdentifier)
        .then(() => ({ resolved: true }))
        .catch((error: { errorCode?: string }) => ({ errorCode: error.errorCode }));
      await secondRuntime.shutdown().catch(() => undefined);
      /** 允许续接成功或按安全对账拒绝；**不得**是租约锁定的错误。 */
      expect((outcome as { errorCode?: string }).errorCode).not.toBe("mission-locked");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
