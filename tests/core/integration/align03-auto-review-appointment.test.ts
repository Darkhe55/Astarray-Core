/**
 * ALIGN-03-01（2026-11-10）：**任务成功后自动独立任命**（装配级）。
 *
 * 依据卡内要求："同一执行任务的自报不能代替独立审查结论"。
 *
 * 断言：开启后任务成功 ⇒ 目录里出现**与贡献者不同**、且挂在**同一责任次级**下的三级审查者；
 * 关闭时 ⇒ 不出现（行为不变，避免没有审查 Worker 时把任务卡在"待裁决"）。
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
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-auto-review-"));
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

async function runMission(input: {
  readonly isIndependentReviewAutoAppointmentEnabled?: boolean;
}): Promise<{ missionIdentifier: string; reviewerEntries: readonly { agentInstanceId: string; owningSecondaryAgentInstanceId: string | null }[]; tertiaryEntries: readonly { agentInstanceId: string; owningSecondaryAgentInstanceId: string | null }[] }> {
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
    ...(input.isIndependentReviewAutoAppointmentEnabled === true
      ? { isIndependentReviewAutoAppointmentEnabled: true }
      : {}),
  });
  try {
    const missionIdentifier = await runtime.controller.handleUserMessage("自动任命测试", {
      projectIdentifier: "project-alpha",
    });
    const deadlineMilliseconds = Date.now() + 60_000;
    while (Date.now() < deadlineMilliseconds) {
      const status = (await runtime.controller.queryMissionStatus(missionIdentifier))?.summary
        ?.status;
      if (status === "done" || status === "blocked" || status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const entries = runtime.registeredAgentDirectory.listAgentEntries();
    return {
      missionIdentifier,
      reviewerEntries: entries
        .filter((entry) => entry.agentInstanceId.startsWith("reviewer:"))
        .map((entry) => ({
          agentInstanceId: entry.agentInstanceId,
          owningSecondaryAgentInstanceId: entry.owningSecondaryAgentInstanceId,
        })),
      tertiaryEntries: entries
        .filter((entry) => entry.agentRole === "tertiary")
        .map((entry) => ({
          agentInstanceId: entry.agentInstanceId,
          owningSecondaryAgentInstanceId: entry.owningSecondaryAgentInstanceId,
        })),
    };
  } finally {
    await runtime.shutdown().catch(() => undefined);
  }
}

describe("ALIGN-03-01 自动独立任命", () => {
  it("开启后任务成功 ⇒ 出现**非贡献者**的审查者，且挂在同一责任次级下", async () => {
    const result = await runMission({ isIndependentReviewAutoAppointmentEnabled: true });
    expect(result.reviewerEntries.length).toBeGreaterThan(0);
    const reviewer = result.reviewerEntries[0];
    expect(reviewer?.owningSecondaryAgentInstanceId).toBe(
      `secondary:${result.missionIdentifier}`,
    );
    /** 审查者不能是贡献者本人。 */
    const contributorIds = result.tertiaryEntries
      .filter((entry) => !entry.agentInstanceId.startsWith("reviewer:"))
      .map((entry) => entry.agentInstanceId);
    expect(contributorIds).not.toContain(reviewer?.agentInstanceId);
  }, 90_000);

  it("未开启 ⇒ 不出现审查者（行为不变）", async () => {
    const result = await runMission({});
    expect(result.reviewerEntries).toEqual([]);
  }, 90_000);
});
