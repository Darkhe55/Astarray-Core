/**
 * RESUME-02（2026-11-07）：生产入口级验证——断点卡 + 显式续接。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

async function createRuntime(stateDirectory: string) {
  return createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 8,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  });
}

describe("断点续接生产入口", () => {
  it("运行中的任务不产生断点；没有断点时请求被拒", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-cont-prod-"));
    directories.push(stateDirectory);
    const runtime = await createRuntime(stateDirectory);
    try {
      const missionId = await runtime.controller.handleUserMessage("断点测试", {
        projectIdentifier: "project-a",
      });
      const deadline = Date.now() + 15_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (status?.summary?.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      const conversationIdentifier = status?.summary?.conversationIdentifier;
      expect(typeof conversationIdentifier).toBe("string");
      const breakpoints = await runtime.controller.queryContinuationBreakpoints(
        conversationIdentifier as string,
      );
      /** 完成的任务不是断点：卡片不出现（不把"已结束"当"可恢复"）。 */
      expect(breakpoints).toEqual([]);
      const rejected = await runtime.controller.requestContinuation({
        breakpointIdentifier: "breakpoint-unknown",
        missionIdentifier: missionId,
        expectedRevision: 1,
        requestIdentifier: "req-prod-1",
      });
      expect(rejected.outcome).toBe("not-found");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("阻塞的任务产生断点卡；点击恢复走既有门禁并如实返回结果", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-cont-prod2-"));
    directories.push(stateDirectory);
    const runtime = await createRuntime(stateDirectory);
    try {
      /** 直接构造一条"已中断"的 mission（真实中断状态的持久化形态）。 */
      await runtime.missionManager.createMission({
        missionId: "mission-interrupted",
        mode: "assist",
        prompt: "中断的任务",
        conversationIdentifier: "conversation-x",
        projectIdentifier: "project-a",
        taskNodes: [
          {
            id: "T-001",
            description: "中断的任务",
            dependsOn: [],
            taskType: "data",
            toolNames: [],
            assignedAgentId: "worker:mission-interrupted:T-001",
            status: "blocked",
            resultLocation: null,
          },
        ],
      });
      await runtime.missionManager.updateMissionStatus("mission-interrupted", "blocked");

      const breakpoints = await runtime.controller.queryContinuationBreakpoints("conversation-x");
      expect(breakpoints).toHaveLength(1);
      const view = breakpoints[0]!;
      expect(view.missionIdentifier).toBe("mission-interrupted");
      expect(view.status).toBe("open");
      expect(view.taskShortName).toBe("中断的任务");
      /** 没有可信检查点 ⇒ 不允许"从检查点继续"（不编造恢复承诺）。 */
      expect(view.canResume).toBe(false);
      expect(view.blockedReason).toContain("可信检查点");

      const result = await runtime.controller.requestContinuation({
        breakpointIdentifier: view.breakpointIdentifier,
        missionIdentifier: view.missionIdentifier,
        expectedRevision: view.revision,
        requestIdentifier: "req-prod-2",
      });
      expect(result.outcome).toBe("not-resumable");

      /** 其他会话看不到这张卡（不串会话）。 */
      expect(await runtime.controller.queryContinuationBreakpoints("conversation-y")).toEqual([]);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
