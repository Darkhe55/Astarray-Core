/**
 * ALIGN-03-07（2026-11-09）：**生产装配真的会关闭三级个体**。
 *
 * 上一轮只做了调度层钩子；若运行时/控制器不装配它，生产里仍是 `undefined`
 * ⇒ 收口依旧不发生（"组件存在但产品不可达"）。
 *
 * 本文件验证：真实装配下任务完成后，该个体在生命周期阶段存储里为 `closed`。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import type { AgentEvent } from "../../../packages/core/src/core/events.js";
import type { AgentRuntime } from "../../../packages/core/src/core/types.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-align0307-wire-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildRuntimeStub(): AgentRuntime {
  return {
    async *run(): AsyncIterable<AgentEvent> {
      yield { kind: "runFinished", agentId: "worker-1", reason: "success", detail: "完成" };
    },
  } as AgentRuntime;
}

describe("ALIGN-03-07 生产装配接线", () => {
  it("任务完成后，该个体在生命周期阶段存储中为 closed", async () => {
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 3,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
      workerRuntimeFactory: () => buildRuntimeStub(),
    });
    try {
      const missionIdentifier = await runtime.controller.handleUserMessage("收口接线测试", {
        projectIdentifier: "project-a",
      });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const status = (await runtime.controller.queryMissionStatus(missionIdentifier))?.summary
          ?.status;
        if (status === "done" || status === "blocked" || status === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const phaseDirectoryPath = path.join(stateDirectory, "tertiary-lifecycle");
      const fileNames = await fs.readdir(phaseDirectoryPath).catch(() => [] as string[]);
      expect(fileNames.length).toBeGreaterThan(0);
      const contents = await Promise.all(
        fileNames.map((fileName) => fs.readFile(path.join(phaseDirectoryPath, fileName), "utf8")),
      );
      /** 至少一个个体被真正关闭（写入了 closedAtIso），而不是"看起来成功"。 */
      expect(contents.some((content) => content.includes("closed"))).toBe(true);

      /**
       * ALIGN-03-07：**接手侧可用** —— 关闭写出的移交文件必须能被读回。
       *
       * 只断言"文件存在"不够：读取要经过校验（版本/个体一致/不合并兄弟记忆）。
       */
      const closedAgentInstanceId = JSON.parse(
        contents.find((content) => content.includes("closed")) ?? "{}",
      ).agentInstanceId as string | undefined;
      expect(typeof closedAgentInstanceId).toBe("string");
      const handoff = await runtime.readTertiaryHandoff({
        agentInstanceId: closedAgentInstanceId as string,
      });
      expect(handoff.kind).toBe("found");
      if (handoff.kind !== "found") return;
      expect(handoff.document.agentInstanceId).toBe(closedAgentInstanceId);
      expect(handoff.document.doesMergeSiblingMemory).toBe(false);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);
});
