/**
 * ALIGN-03-01/04（2026-11-10）：**未绑定责任次级 ⇒ 阻断派发**（强制开启时）。
 *
 * 依据用户归属裁决："缺失、失效或不匹配的归属应阻断派发并报告，不猜测身份。"
 *
 * 本文件钉住两条相反的行为，防止"阻断"被写成"默默照旧派发"：
 *  ① 强制开启 + 无责任次级 ⇒ **不构造 Worker**，并报告原因码；
 *  ② 强制关闭 + 无责任次级 ⇒ 保持旧行为（照常派发），用于尚未迁移的装配路径。
 */
import { describe, expect, it, vi } from "vitest";

import { MissionOrchestrator } from "../../../packages/core/src/orchestration/mission-orchestrator.js";

vi.setConfig({ testTimeout: 30_000 });

const BUILD_REACHED = "build-reached";

class TestOrchestrator extends MissionOrchestrator {
  public isBuildReached = false;

  protected override buildWorkerAgent(): never {
    this.isBuildReached = true;
    throw new Error(BUILD_REACHED);
  }

  public async dispatch(taskIdentifier: string): Promise<void> {
    await this.launchWorker({ action: "start-task", taskId: taskIdentifier } as never);
  }
}

function buildOrchestrator(input: {
  readonly isWorkerOwnershipEnforced?: boolean;
  readonly secondaryAgentInstanceId?: string;
  readonly escalationMessages: string[];
}): TestOrchestrator {
  const task = {
    id: "task-1",
    description: "只读分析",
    dependsOn: [],
    taskType: "implementation",
    toolNames: [],
    assignedAgentId: null,
    status: "pending",
    resultLocation: null,
  };
  return new TestOrchestrator({
    initialChain: {
      schemaVersion: 1,
      missionId: "mission-1",
      revision: 1,
      updatedAtIso: "2026-11-10T00:00:00.000Z",
      tasks: [task],
    },
    missionId: "mission-1",
    concurrency: 1,
    taskStore: { readTaskChain: async () => null, writeTaskChain: async () => {} },
    feedbackTransportFactory: async () => ({
      onMessage: () => {},
      enqueue: async () => {},
      queryHealth: async () => ({
        isHealthy: true,
        processPid: 0,
        protocolVersion: 1,
        queuedMessageCount: 0,
      }),
      shutdown: async () => {},
      setAgentStatus: () => {},
    }),
    workerFactories: {
      runtimeFactory: () => ({}),
      /** 走到构造 Worker 时才需要；本用例只关心"是否走到"。 */
      toolPortFactory: () => ({ executeTool: async () => ({ ok: true }) }),
    },
    onUserEscalation: (message: string) => {
      input.escalationMessages.push(message);
    },
    ...(input.isWorkerOwnershipEnforced === undefined
      ? {}
      : { isWorkerOwnershipEnforced: input.isWorkerOwnershipEnforced }),
    ...(input.secondaryAgentInstanceId === undefined
      ? {}
      : { secondaryAgentInstanceId: input.secondaryAgentInstanceId }),
  } as never);
}

describe("ALIGN-03 未绑定归属", () => {
  it("**强制开启 + 无责任次级 ⇒ 不构造 Worker，并报告原因码**", async () => {
    const escalationMessages: string[] = [];
    const orchestrator = buildOrchestrator({
      isWorkerOwnershipEnforced: true,
      escalationMessages,
    });
    await orchestrator.dispatch("task-1");
    expect(orchestrator.isBuildReached).toBe(false);
    expect(escalationMessages.join("\n")).toContain("mission-responsible-secondary-unbound");
  }, 30_000);

  it("强制关闭 + 无责任次级 ⇒ 照常派发（未迁移路径行为不变）", async () => {
    const escalationMessages: string[] = [];
    const orchestrator = buildOrchestrator({ escalationMessages });
    /** 走到构造 Worker 即证明"照常派发"（本夹具在构造处抛 BUILD_REACHED 作为到达信号）。 */
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(orchestrator.isBuildReached).toBe(true);
    expect(escalationMessages).toEqual([]);
  }, 30_000);

  it("**强制开启 + 责任次级是 scheduler 标签 ⇒ 阻断**（调度器不是 Agent）", async () => {
    const escalationMessages: string[] = [];
    const orchestrator = buildOrchestrator({
      isWorkerOwnershipEnforced: true,
      secondaryAgentInstanceId: "scheduler:mission-1",
      escalationMessages,
    });
    await orchestrator.dispatch("task-1");
    expect(orchestrator.isBuildReached).toBe(false);
  }, 30_000);

  it("有真实责任次级 ⇒ 照常派发", async () => {
    const escalationMessages: string[] = [];
    const orchestrator = buildOrchestrator({
      isWorkerOwnershipEnforced: true,
      secondaryAgentInstanceId: "secondary:mission-1",
      escalationMessages,
    });
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(orchestrator.isBuildReached).toBe(true);
  }, 30_000);
});
