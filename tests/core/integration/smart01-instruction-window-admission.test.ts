/**
 * SMART-01（用户裁决 2026-11-09）：**窗口满时禁止越窗准入与启动**。
 *
 * 裁决原文要点：
 *  - 窗口满 ⇒ 新业务指令**继续接收并持久化排队**，但**不得越窗启动**；
 *  - 已准入任务及其必要下级派发继续执行；
 *  - 主 Agent 完成持久化交办并拿到回执后可**释放槽位**，不等待下级成果；
 *  - 取消/暂停/撤权走**独立控制通道**（不受窗口约束）；
 *  - 沿用统一任务序列。
 *
 * 本文件覆盖裁决点名的四条应用入口测试。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRuntime } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-smart01-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

/**
 * 受控 worker：**阻塞**直到测试放行，用于稳定构造"窗口占满"。
 *
 * 不阻塞就无法确定第 4 条提交时前 3 条是否仍在窗口内（那样测出来的是竞态，不是语义）。
 */
function buildBlockingRuntime(gate: { isReleased: boolean; waiters: Array<() => void> }): AgentRuntime {
  return {
    async *run(): AsyncIterable<AgentEvent> {
      if (!gate.isReleased) {
        await new Promise<void>((resolve) => {
          gate.waiters.push(resolve);
        });
      }
      yield { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" };
    },
  } as AgentRuntime;
}

function releaseAll(gate: { isReleased: boolean; waiters: Array<() => void> }): void {
  gate.isReleased = true;
  for (const waiter of gate.waiters.splice(0)) waiter();
}

async function buildFacade() {
  const gate = { isReleased: false, waiters: [] as Array<() => void> };
  const runtime = await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 4,
    failureThreshold: 1,
    maxLoopIterations: 2,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
    workerRuntimeFactory: () => buildBlockingRuntime(gate),
  });
  /** 指令窗口必须落盘：门面显式给出状态目录（缺省会 fail-closed）。 */
  const facade = new AstarrayApplicationFacade(runtime, { stateDirectory });
  const session = await facade.createSession({ sessionId: "session-smart01", mode: "assist" });
  return { facade, runtime, gate, sessionId: session.sessionId };
}

describe("SMART-01 指令窗口准入", () => {
  it("第 4 条业务指令：应用入口排队（不启动），且前 3 条已在跑", async () => {
    const { facade, runtime, gate, sessionId } = await buildFacade();
    try {
      const admitted: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const result = await facade.submitTask({
          sessionId,
          taskIdentifier: "task-" + String(index),
          prompt: "业务指令 " + String(index),
        });
        admitted.push(result.status);
      }
      expect(admitted.every((status) => status === "accepted")).toBe(true);

      const fourth = await facade.submitTask({
        sessionId,
        taskIdentifier: "task-3",
        prompt: "第 4 条业务指令",
      });
      /** 接收了、持久化了，但**没有启动**。 */
      expect(fourth.status).toBe("queued");
      expect(fourth.missionIdentifier).toBeNull();

      const queuedSnapshot = await facade.queryTask({
        sessionId,
        taskIdentifier: "task-3",
      });
      expect(queuedSnapshot.status).toBe("queued");
    } finally {
      releaseAll(gate);
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("释放槽位后**只补一条**：排队中的第 5 条仍然等待", async () => {
    const { facade, runtime, gate, sessionId } = await buildFacade();
    try {
      for (let index = 0; index < 3; index += 1) {
        await facade.submitTask({
          sessionId,
          taskIdentifier: "task-" + String(index),
          prompt: "业务指令 " + String(index),
        });
      }
      await facade.submitTask({ sessionId, taskIdentifier: "task-3", prompt: "第 4 条" });
      await facade.submitTask({ sessionId, taskIdentifier: "task-4", prompt: "第 5 条" });

      /** 取消第 1 条 ⇒ 释放一个槽位 ⇒ 只应补上 task-3。 */
      await facade.cancelTask({ sessionId, taskIdentifier: "task-0" });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const third = await facade.queryTask({ sessionId, taskIdentifier: "task-3" });
      const fourth = await facade.queryTask({ sessionId, taskIdentifier: "task-4" });
      expect(third.status).not.toBe("queued");
      expect(fourth.status).toBe("queued");
    } finally {
      releaseAll(gate);
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("并发提交不越窗：同时提交 6 条，最多 3 条进入 accepted", async () => {
    const { facade, runtime, gate, sessionId } = await buildFacade();
    try {
      const results = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((index) =>
          facade.submitTask({
            sessionId,
            taskIdentifier: "task-" + String(index),
            prompt: "并发指令 " + String(index),
          }),
        ),
      );
      const acceptedCount = results.filter((result) => result.status === "accepted").length;
      const queuedCount = results.filter((result) => result.status === "queued").length;
      expect(acceptedCount).toBe(3);
      expect(queuedCount).toBe(3);
    } finally {
      releaseAll(gate);
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);

  it("取消不受窗口约束：排队中的任务也能立即取消", async () => {
    const { facade, runtime, gate, sessionId } = await buildFacade();
    try {
      for (let index = 0; index < 3; index += 1) {
        await facade.submitTask({
          sessionId,
          taskIdentifier: "task-" + String(index),
          prompt: "业务指令 " + String(index),
        });
      }
      const queued = await facade.submitTask({
        sessionId,
        taskIdentifier: "task-3",
        prompt: "第 4 条",
      });
      expect(queued.status).toBe("queued");

      /** 控制通道：不申请槽位，直接取消。 */
      await facade.cancelTask({ sessionId, taskIdentifier: "task-3" });
      const cancelled = await facade.queryTask({ sessionId, taskIdentifier: "task-3" });
      expect(cancelled.status).toBe("cancelled");
    } finally {
      releaseAll(gate);
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
