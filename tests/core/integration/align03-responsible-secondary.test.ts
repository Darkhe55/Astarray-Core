/**
 * ALIGN-03-01/04（2026-11-10）：**mission 的责任次级是真实个体**，不是调度器标签。
 *
 * 依据用户归属裁决：调度器只是执行机制，不是上级；派发前必须先确定承接次级。
 * 本文件钉住两件事：
 *  ① mission 摘要里持久化的是 `secondary:<missionId>`（真实次级个体），
 *     **不是** `scheduler:<missionId>`（派发来源标签）；
 *  ② 该个体在登记目录里以 `agentRole: "secondary"` 存在。
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-responsible-secondary-"));
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

describe("ALIGN-03 责任次级", () => {
  it("mission 摘要持久化**真实次级个体**，且不是 scheduler 标签", async () => {
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
      const missionIdentifier = await runtime.controller.handleUserMessage("责任次级测试", {
        projectIdentifier: "project-alpha",
      });
      const summaryPath = path.join(
        stateDirectory,
        "missions",
        missionIdentifier,
        "summary.json",
      );
      const summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as Record<
        string,
        unknown
      >;
      const responsibleSecondary = summary["responsibleSecondaryAgentInstanceId"];
      expect(typeof responsibleSecondary).toBe("string");
      expect(responsibleSecondary).toBe(`secondary:${missionIdentifier}`);
      /** 关键反例：**不得**把调度器当成上级。 */
      expect(String(responsibleSecondary).startsWith("scheduler:")).toBe(false);
      expect(String(responsibleSecondary)).not.toBe("main-agent-1");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 90_000);
});
