/**
 * WORKWINDOW-01-02 派发门禁接线反例（2026-10-20）。
 *
 * 用**子类 + 真实 launchWorker 代码路径**验证（不复制逻辑）：
 * - 门禁 deny ⇒ **不建 Worker**、如实升级原因、使命收口 cancelled；
 * - 门禁 allow ⇒ 真的走到建 Worker（用哨兵错误证明到达）；
 * - **未提供门禁 ⇒ 行为不变**（同样走到建 Worker）；
 * - 门禁入参正确（missionId / taskIdentifier / gatePoint）。
 */
import { describe, expect, it } from "vitest";

import { MissionOrchestrator } from "../../../packages/core/src/orchestration/mission-orchestrator.js";

const BUILD_REACHED = "build-reached";

class TestOrchestrator extends MissionOrchestrator {
  public isBuildReached = false;

  /** 覆写构造点：只用于证明"是否走到派发"。 */
  protected override buildWorkerAgent(): never {
    this.isBuildReached = true;
    throw new Error(BUILD_REACHED);
  }

  /** 把 protected 的派发入口暴露给测试。 */
  public async dispatch(taskIdentifier: string): Promise<void> {
    await this.launchWorker({ action: "start-task", taskId: taskIdentifier } as never);
  }
}

type WorkWindowGate = (input: {
  missionId: string;
  taskIdentifier: string;
  gatePoint: "dispatch";
}) => Promise<
  | { readonly kind: "allow"; readonly reason: string }
  | {
      readonly kind: "deny";
      readonly reasonCode: string;
      readonly reason: string;
      readonly activePauseReasonKinds?: ReadonlyArray<string>;
    }
>;

function buildOrchestrator(options: {
  workWindowGate?: WorkWindowGate;
  escalations?: string[];
  finished?: Array<"done" | "cancelled">;
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
      updatedAtIso: "2026-10-20T00:00:00.000Z",
      tasks: [task],
    },
    missionId: "mission-1",
    concurrency: 1,
    taskStore: {
      readTaskChain: async () => null,
      writeTaskChain: async () => {},
    },
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
    onUserEscalation: (message: string) => {
      options.escalations?.push(message);
    },
    onMissionFinished: (status: "done" | "cancelled") => {
      options.finished?.push(status);
    },
    ...(options.workWindowGate === undefined ? {} : { workWindowGate: options.workWindowGate }),
  } as never);
}

describe("WORKWINDOW-01-02 派发门禁接线", () => {
  it("① 门禁拒绝 ⇒ 不建 Worker、升级原因、使命收口 cancelled", async () => {
    const escalations: string[] = [];
    const finished: Array<"done" | "cancelled"> = [];
    const orchestrator = buildOrchestrator({
      escalations,
      finished,
      workWindowGate: async () => ({
        kind: "deny",
        reasonCode: "paused",
        reason: "存在暂停原因：user-paused",
        activePauseReasonKinds: ["user-paused", "watchdog"],
      }),
    });

    await orchestrator.dispatch("task-1");

    expect(orchestrator.isBuildReached).toBe(false);
    expect(finished).toEqual(["cancelled"]);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain("未派发任务 task-1");
    // 全部暂停原因都要能看到（不折叠）
    expect(escalations[0]).toContain("user-paused");
    expect(escalations[0]).toContain("watchdog");
  });

  it("② 门禁放行 ⇒ 真的走到建 Worker（哨兵证明）", async () => {
    const orchestrator = buildOrchestrator({
      workWindowGate: async () => ({ kind: "allow", reason: "工作时段" }),
    });
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(orchestrator.isBuildReached).toBe(true);
  });

  it("③ 未提供门禁 ⇒ 行为不变（同样走到建 Worker）", async () => {
    const orchestrator = buildOrchestrator({});
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(orchestrator.isBuildReached).toBe(true);
  });

  it("④ 门禁入参正确：missionId / taskIdentifier / gatePoint=dispatch", async () => {
    const received: Array<{ missionId: string; taskIdentifier: string; gatePoint: string }> = [];
    const orchestrator = buildOrchestrator({
      workWindowGate: async (input) => {
        received.push(input);
        return { kind: "allow", reason: "工作时段" };
      },
    });
    await expect(orchestrator.dispatch("task-1")).rejects.toThrow(BUILD_REACHED);
    expect(received).toEqual([
      { missionId: "mission-1", taskIdentifier: "task-1", gatePoint: "dispatch" },
    ]);
  });

  it("⑤ 门禁拒绝时**不产生** done（不会既取消又完成）", async () => {
    const finished: Array<"done" | "cancelled"> = [];
    const orchestrator = buildOrchestrator({
      finished,
      workWindowGate: async () => ({
        kind: "deny",
        reasonCode: "resting",
        reason: "当前处于休息时段：不派发新工作。",
      }),
    });
    await orchestrator.dispatch("task-1");
    expect(finished).toEqual(["cancelled"]);
    expect(finished).not.toContain("done");
  });
});


