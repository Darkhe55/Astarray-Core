/**
 * ALIGN-02-07（2026-11-08）：有界退避 / 无工作空闲 / 失败重派上限 —— **真实时钟与取消联动**。
 *
 * 现状缺口（卡内如实记录）：退避只在测试里断言过 `recommendedWaitMilliseconds` 的**数值**，
 * 从未验证"循环真的按该值等待、且等待可被事件/停止立即打断"。
 */
import { describe, expect, it, vi } from "vitest";

import { SecondaryContinuousDispatchLoop } from "../../../packages/core/src/orchestration/secondary-continuous-dispatch-loop.js";
import { UnboundedAgentInstanceRegistry } from "../../../packages/core/src/orchestration/unbounded-agent-registry.js";

function createLoop() {
  const registry = new UnboundedAgentInstanceRegistry({
    maxConcurrentSlots: 1,
    maxQueueLength: 1,
  });
  return new SecondaryContinuousDispatchLoop({ registry });
}

const node = (taskId: string) =>
  ({ taskId, status: "pending", dependsOn: [], priorityTier: 0 }) as never;

describe("有界退避与唤醒（ALIGN-02-07）", () => {
  it("无工作 ⇒ 空闲等待 30s；不忙轮询", () => {
    const loop = createLoop();
    expect(loop.getRecommendedWaitMilliseconds()).toBe(
      SecondaryContinuousDispatchLoop.IDLE_WAIT_MILLISECONDS,
    );
  });

  it("有进展 ⇒ 短暂等待；连续无进展 ⇒ 指数退避并封顶", async () => {
    const loop = createLoop();
    loop.registerMissionPorts("mission-1", {
      claimTask: async () => true,
      dispatchChain: async () => true,
    });
    await loop.runRound({ nodes: [node("T-1")], missionIdentifier: "mission-1" });
    expect(loop.getRecommendedWaitMilliseconds()).toBe(
      SecondaryContinuousDispatchLoop.PROGRESS_WAIT_MILLISECONDS,
    );

    /** 后续轮次没有可执行任务（节点还是 pending 但同 id 已被领过 ⇒ 无进展）。 */
    for (let round = 1; round <= 3; round += 1) {
      await loop.runRound({ nodes: [node("T-1")], missionIdentifier: "mission-1" });
      expect(loop.getConsecutiveNoProgressRoundCount()).toBeGreaterThanOrEqual(round);
    }
    expect(loop.getRecommendedWaitMilliseconds()).toBeGreaterThan(
      SecondaryContinuousDispatchLoop.MINIMUM_BACKOFF_MILLISECONDS,
    );
    expect(loop.getRecommendedWaitMilliseconds()).toBeLessThanOrEqual(
      SecondaryContinuousDispatchLoop.MAXIMUM_BACKOFF_MILLISECONDS,
    );
  });

  it("等待可被事件立即打断（不必等满退避）", async () => {
    const loop = createLoop();
    const startedAtMilliseconds = Date.now();
    const waiting = loop.waitForNextWake(
      SecondaryContinuousDispatchLoop.IDLE_WAIT_MILLISECONDS,
    );
    loop.notifySchedulingEvent("task-finished");
    const report = await waiting;
    /** 唤醒原因如实回报触发事件名（不统一写成笼统 "event"）。 */
    expect(report.reason).toBe("task-finished");
    expect(Date.now() - startedAtMilliseconds).toBeLessThan(1_000);
  });

  it("停止后等待立即返回（不卡住退出）", async () => {
    const loop = createLoop();
    const startedAtMilliseconds = Date.now();
    const waiting = loop.waitForNextWake(
      SecondaryContinuousDispatchLoop.IDLE_WAIT_MILLISECONDS,
    );
    loop.stop();
    const report = await waiting;
    expect(Date.now() - startedAtMilliseconds).toBeLessThan(1_000);
    expect(report.reason).not.toBe("event");
  });

  it("同一任务连续失败达到上限后停止重派；状态变化后可重置", async () => {
    const loop = createLoop();
    const dispatchAttempts = vi.fn(async () => false);
    loop.registerMissionPorts("mission-2", {
      claimTask: async () => true,
      dispatchChain: dispatchAttempts,
      releaseTask: async () => undefined,
    });
    for (
      let attempt = 1;
      attempt <= SecondaryContinuousDispatchLoop.MAXIMUM_DISPATCH_ATTEMPTS_PER_TASK;
      attempt += 1
    ) {
      await loop.runRound({ nodes: [node("T-2")], missionIdentifier: "mission-2" });
    }
    const blockedRound = await loop.runRound({
      nodes: [node("T-2")],
      missionIdentifier: "mission-2",
    });
    expect(blockedRound.skippedReasons["T-2"]).toContain("停止自动重派");
    expect(dispatchAttempts).toHaveBeenCalledTimes(
      SecondaryContinuousDispatchLoop.MAXIMUM_DISPATCH_ATTEMPTS_PER_TASK,
    );

    loop.resetDispatchFailureCounts();
    const retried = await loop.runRound({
      nodes: [node("T-2")],
      missionIdentifier: "mission-2",
    });
    expect(dispatchAttempts).toHaveBeenCalledTimes(
      SecondaryContinuousDispatchLoop.MAXIMUM_DISPATCH_ATTEMPTS_PER_TASK + 1,
    );
    expect(retried.skippedReasons["T-2"] ?? "").not.toContain("停止自动重派");
  });
});
