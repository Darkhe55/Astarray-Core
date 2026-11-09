/**
 * ALIGN-04-05（2026-11-09）：**回访入口的拒绝路径**。
 *
 * 卡内 2026-10-28 记录"未跑任何一条回访路径"。
 * 本文件覆盖入口侧两条拒绝语义（成功路径需要真实胶囊与 provider，另作一轮）：
 *  ① 未装配回访控制器 ⇒ 拒绝（**不伪造历史**）；
 *  ② 调用者身份为空 ⇒ 拒绝（身份由 harness 注入，模型不可填）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-align0405-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function buildRuntime() {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
  });
}

describe("ALIGN-04-05 回访入口拒绝路径", () => {
  it("调用者身份为空 ⇒ 拒绝（身份由 harness 注入，模型不可填）", async () => {
    const runtime = await buildRuntime();
    try {
      await expect(
        runtime.controller.recallClosedContext({
          callerAgentInstanceId: "   ",
          request: { nodeIdentifier: "node-1" },
        }),
      ).rejects.toThrow(/身份缺失|context-recall-invalid/u);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("请求未绑定必要字段 ⇒ 拒绝（不得凭不完整请求回访）", async () => {
    const runtime = await buildRuntime();
    try {
      /**\n       * 实测发现：`contextRecallControllerFactory` **默认已装配**（卡内"未装配"是旧状态），\n       * 因此这里走的是**请求校验**分支 —— 不完整请求一律拒绝。\n       */
      const error = await runtime.controller
        .recallClosedContext({
          callerAgentInstanceId: "worker:task-1",
          request: { nodeIdentifier: "node-1" },
        })
        .then(() => null)
        .catch((caught: unknown) => caught as Error);
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/回访请求非法|context-recall-invalid/u);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
