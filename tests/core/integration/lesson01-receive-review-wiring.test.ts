/**
 * LESSON-01-03 **接收/审查节点**接线反例（2026-10-20）。
 *
 * 全部经**真实派发路径**（不碰私有方法）：断言接收端口在 `run` 之前调用、
 * 审查端口拿到真实结局、两端口抛错都不阻塞、未提供时行为不变。
 */
import { describe, expect, it } from "vitest";

import { MissionOrchestrator } from "../../../packages/core/src/orchestration/mission-orchestrator.js";

class OrderCapturingOrchestrator extends MissionOrchestrator {
  public order: string[] = [];
  public workerOutcome: "success" | "failure" | "ambiguous" = "success";

  protected override buildWorkerAgent(): never {
    this.order.push("build");
    const self = this;
    return {
      run: async () => {
        self.order.push("run");
        return {
          outcome: self.workerOutcome,
          toolName: null,
          failureReason: self.workerOutcome === "failure" ? "失败" : null,
          stateSummary: "测试收口",
        };
      },
    } as never;
  }

  public async dispatch(taskIdentifier: string): Promise<void> {
    await this.launchWorker({ action: "start-task", taskId: taskIdentifier } as never);
    // 等内部 workerPromise 收口（含审查端口调用）
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type ReceivePort = (input: { missionId: string; taskIdentifier: string }) => Promise<void>;
type ReviewPort = (input: {
  missionId: string;
  taskIdentifier: string;
  outcome: "success" | "failure" | "ambiguous";
}) => Promise<void>;

function buildOrchestrator(options: {
  lessonReceivePort?: ReceivePort;
  lessonReviewPort?: ReviewPort;
  workerOutcome?: "success" | "failure" | "ambiguous";
}): OrderCapturingOrchestrator {
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
  const orchestrator = new OrderCapturingOrchestrator({
    initialChain: {
      schemaVersion: 1,
      missionId: "mission-1",
      revision: 1,
      updatedAtIso: "2026-10-20T00:00:00.000Z",
      tasks: [task],
    },
    missionId: "mission-1",
    concurrency: 1,
    taskStore: { readTaskChain: async () => null, writeTaskChain: async () => {} },
    feedbackTransportFactory: async () => ({
      onMessage: () => {},
      enqueue: async () => {},
      queryHealth: async () => ({ isHealthy: true, processPid: 0, protocolVersion: 1, queuedMessageCount: 0 }),
      shutdown: async () => {},
      setAgentStatus: () => {},
    }),
    workerFactories: {
      runtimeFactory: () => ({}),
      toolPortFactory: () => ({}),
      buildPermissionExplanation: () => "无需工具",
    },
    maxLoopIterations: 1,
    onUserEscalation: () => {},
    onMissionFinished: () => {},
    ...(options.lessonReceivePort === undefined ? {} : { lessonReceivePort: options.lessonReceivePort }),
    ...(options.lessonReviewPort === undefined ? {} : { lessonReviewPort: options.lessonReviewPort }),
  } as never);
  if (options.workerOutcome !== undefined) orchestrator.workerOutcome = options.workerOutcome;
  return orchestrator;
}

describe("LESSON-01-03 接收/审查节点接线", () => {
  it("① 接收端口在 run **之前**被调用", async () => {
    const order: string[] = [];
    const orchestrator = buildOrchestrator({
      lessonReceivePort: async () => {
        order.push("receive");
        orchestratorOrder.push("receive");
      },
    });
    const orchestratorOrder = orchestrator.order;
    await orchestrator.dispatch("task-1");
    const receiveIndex = orchestratorOrder.indexOf("receive");
    const runIndex = orchestratorOrder.indexOf("run");
    expect(receiveIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(receiveIndex);
  });

  it("② 审查端口携带真实结局 success", async () => {
    const received: Array<{ taskIdentifier: string; outcome: string }> = [];
    const orchestrator = buildOrchestrator({
      lessonReviewPort: async (input) => {
        received.push({ taskIdentifier: input.taskIdentifier, outcome: input.outcome });
      },
    });
    await orchestrator.dispatch("task-1");
    expect(received).toEqual([{ taskIdentifier: "task-1", outcome: "success" }]);
  });

  it("③ 审查端口看到 failure 结局（不把失败报成成功）", async () => {
    const received: string[] = [];
    const orchestrator = buildOrchestrator({
      workerOutcome: "failure",
      lessonReviewPort: async (input) => {
        received.push(input.outcome);
      },
    });
    await orchestrator.dispatch("task-1");
    expect(received).toEqual(["failure"]);
  });

  it("④ 审查端口抛错 ⇒ 派发不抛（收口不被阻塞）", async () => {
    const orchestrator = buildOrchestrator({
      lessonReviewPort: async () => {
        throw new Error("审查存储不可读");
      },
    });
    await expect(orchestrator.dispatch("task-1")).resolves.toBeUndefined();
  });

  it("⑤ 接收端口抛错 ⇒ 任务仍被执行（run 被调用）", async () => {
    const orchestrator = buildOrchestrator({
      lessonReceivePort: async () => {
        throw new Error("投递失败");
      },
    });
    await orchestrator.dispatch("task-1");
    expect(orchestrator.order).toContain("run");
  });

  it("⑥ 两个端口都不提供 ⇒ 行为不变（run 照常）", async () => {
    const orchestrator = buildOrchestrator({});
    await orchestrator.dispatch("task-1");
    expect(orchestrator.order).toContain("run");
  });
});
