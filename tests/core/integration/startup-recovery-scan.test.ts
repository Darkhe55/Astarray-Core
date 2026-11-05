/**
 * 启动自动恢复 Phase 1（2026-11-05）：运行时只读扫描。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { MissionRelationIndexStore } from "../../../packages/core/src/orchestration/mission-relation-index.js";
import { DEFAULT_STARTUP_RECOVERY_POLICY } from "../../../packages/core/src/orchestration/startup-recovery-policy.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("启动恢复只读扫描（运行时）", () => {
  it("识别被中断的 mission，并只读返回报告", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-startup-scan-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
      startupRecoveryPolicy: {
        ...DEFAULT_STARTUP_RECOVERY_POLICY,
        isEnabled: true,
        maximumResumePerStartup: 3,
        allowedTaskLabels: ["normal", "unknown"],
      },
    });
    try {
      const owner = "secondary-scan-1";
      const sequenceId = `sequence-${owner}`;
      const taskId = "task-mission-scan-1";
      await runtime.taskSequenceManageController.publishSequence({
        ownerAgentInstanceId: owner,
        actor: { sourceKind: "user", actorId: "user-1" },
        sequenceId,
        firstTask: {
          taskId,
          title: "被中断的任务",
          priorityTier: 0,
          externalReference: "mission:mission-scan-1",
        },
      });
      await runtime.taskSequenceManageController.transitionTaskStatus({
        ownerAgentInstanceId: owner,
        actor: { sourceKind: "agent", actorId: owner },
        sequenceId,
        expectedRevision: 2,
        taskId,
        nextStatus: "running",
        blockReason: null,
      });
      await runtime.missionManager.createMission({
        missionId: "mission-scan-1",
        mode: "assist",
        prompt: "被中断的任务",
        taskNodes: [
          {
            id: "T-001",
            description: "被中断的任务",
            dependsOn: [],
            taskType: "data",
            toolNames: [],
            assignedAgentId: null,
            status: "running",
            resultLocation: null,
          },
        ],
        taskSequenceIdentifier: sequenceId,
        originalTaskIdentifier: taskId,
      });
      const relationStore = new MissionRelationIndexStore({ baseDirectory: stateDirectory });
      await relationStore.upsert({
        missionIdentifier: "mission-scan-1",
        projectIdentifier: "project-a",
        conversationIdentifier: "conversation-1",
        taskSequenceIdentifier: sequenceId,
        taskIdentifier: taskId,
        sequenceOwnerAgentInstanceIdentifier: owner,
      });

      const report = await runtime.scanStartupRecovery();
      expect(report.views).toHaveLength(1);
      expect(report.views[0]?.missionStatus).toBe("running");
      expect(report.views[0]?.sequenceTaskStatus).toBe("running");
      expect(report.selected.map((entry) => entry.missionIdentifier)).toEqual([
        "mission-scan-1",
      ]);
      expect(report.selected[0]?.ownerAgentInstanceIdentifier).toBe(owner);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});

describe("启动恢复执行（运行时）", () => {
  it("sequence-only 任务不会假装恢复：报告 skip 原因", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-startup-run-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 8,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
      startupRecoveryPolicy: {
        ...DEFAULT_STARTUP_RECOVERY_POLICY,
        isEnabled: true,
        allowedTaskLabels: ["normal", "unknown"],
      },
    });
    try {
      await runtime.taskSequenceManageController.publishSequence({
        ownerAgentInstanceId: "secondary-run-1",
        actor: { sourceKind: "user", actorId: "user-1" },
        sequenceId: "sequence-secondary-run-1",
        firstTask: {
          taskId: "task-run-1",
          title: "未完成但无 mission",
          priorityTier: 0,
          externalReference: null,
        },
      });
      const result = await runtime.runStartupRecovery();
      expect(result.scan.selected.some((entry) => entry.kind === "sequence-only")).toBe(true);
      expect(result.run.resumed).toHaveLength(0);
      expect(result.run.skipped.map((entry) => entry.reason).join("\n")).toContain(
        "sequence-only-not-dispatched",
      );
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
