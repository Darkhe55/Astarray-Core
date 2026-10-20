/**
 * LESSON-01-03 **分派节点**接线反例（2026-10-20）。
 *
 * 断言：端口被调用且入参正确；**拒绝不阻塞派发**；**抛错不阻塞派发**（教训是建议性的）；
 * 未提供端口 ⇒ 行为不变。
 */
import { describe, expect, it } from "vitest";

import { MissionOrchestrator } from "../../../packages/core/src/orchestration/mission-orchestrator.js";

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

type LessonPort = (input: { missionId: string; taskIdentifier: string }) => Promise<
  | { readonly kind: "deliver"; readonly deliveryKeys: ReadonlyArray<string> }
  | { readonly kind: "rejected"; readonly reason: string }
>;

function buildOrchestrator(options: { lessonDispatchPort?: LessonPort }): TestOrchestrator {
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
    ...(options.lessonDispatchPort === undefined ? {} : { lessonDispatchPort: options.lessonDispatchPort }),
  } as never);
}

describe("LESSON-01-03 分派节点接线", () => {
  it("① 端口被调用，入参为 missionId + taskIdentifier", async () => {
    const calls: Array<{ missionId: string; taskIdentifier: string }> = [];
    const orchestrator = buildOrchestrator({
      lessonDispatchPort: async (input) => {
        calls.push(input);
        return { kind: "deliver", deliveryKeys: ["key-1"] };
      },
    });
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(calls).toEqual([{ missionId: "mission-1", taskIdentifier: "task-1" }]);
  });

  it("② 端口拒绝投递 ⇒ 仍继续派发（教训是建议性的）", async () => {
    const orchestrator = buildOrchestrator({
      lessonDispatchPort: async () => ({ kind: "rejected", reason: "自动总结已关闭" }),
    });
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(orchestrator.isBuildReached).toBe(true);
  });

  it("③ 端口抛错 ⇒ 仍继续派发（不能成为单点故障）", async () => {
    const orchestrator = buildOrchestrator({
      lessonDispatchPort: async () => {
        throw new Error("存档不可读");
      },
    });
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(orchestrator.isBuildReached).toBe(true);
  });

  it("④ 未提供端口 ⇒ 行为不变（照常派发）", async () => {
    const orchestrator = buildOrchestrator({});
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(orchestrator.isBuildReached).toBe(true);
  });
});
