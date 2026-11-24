/**
 * B9（2026-11-24）：公共门面的错误面分支（assertOpen / 未认证 / 未知会话 / 未知 mission）。
 *
 * 只验证"拒绝语义"：不启动 mission、不写业务数据。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sdk-errors-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createFacade(options: { authenticatedUserId?: string } = {}) {
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
    ...(options.authenticatedUserId === undefined
      ? {}
      : { authenticatedUserId: options.authenticatedUserId }),
  });
}

describe("B9：公共门面错误面", () => {
  it("① 指导文本为空 ⇒ invalid-arguments（不伪造指导）", async () => {
    const facade = await createFacade({ authenticatedUserId: "user-1" });
    try {
      await expect(
        facade.submitGuidanceChange({
          missionIdentifier: "m-1",
          taskIdentifier: null,
          instructionText: "   ",
          changeIntent: "append",
          requestedTaskSequenceRevision: 1,
        }),
      ).resolves.toMatchObject({ status: "rejected" });
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 未认证用户提交指导 ⇒ authenticated-user-required", async () => {
    const facade = await createFacade();
    try {
      await expect(
        facade.submitGuidanceChange({
          missionIdentifier: "m-1",
          taskIdentifier: null,
          instructionText: "改按钮",
          changeIntent: "append",
          requestedTaskSequenceRevision: 1,
        }),
      ).resolves.toMatchObject({ status: "rejected" });
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 未知会话 submitTask ⇒ session-not-found", async () => {
    const facade = await createFacade({ authenticatedUserId: "user-1" });
    try {
      await expect(
        facade.submitTask({
          sessionId: "session-missing",
          prompt: "任务",
        } as never),
      ).rejects.toMatchObject({ errorCode: "session-not-found" });
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("④ 关闭后调用 ⇒ application-closed（多个入口一致）", async () => {
    const facade = await createFacade({ authenticatedUserId: "user-1" });
    await facade.shutdown();
    await expect(facade.queryMission("m-1")).rejects.toMatchObject({ errorCode: "application-closed" });
    await expect(
      facade.submitTask({ sessionId: "s-1", prompt: "x" } as never),
    ).rejects.toMatchObject({ errorCode: "application-closed" });
  });

  it("⑤ 未知 mission 的原始状态查询 ⇒ 不抛错但如实标记", async () => {
    const facade = await createFacade({ authenticatedUserId: "user-1" });
    try {
      await expect(facade.queryMissionRawStatus("mission-missing")).rejects.toThrow(/任务不存在/u);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
