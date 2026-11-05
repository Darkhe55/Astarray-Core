/**
 * 启动自动恢复 Phase 3（2026-11-05）：从 mission 元数据派生标签。
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

describe("启动恢复标签派生", () => {
  it("写工具 ⇒ has-writes；只读工具 ⇒ normal", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-startup-labels-"));
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
      },
    });
    try {
      const relationStore = new MissionRelationIndexStore({ baseDirectory: stateDirectory });
      const cases = [
        { suffix: "write", toolName: "createProjectFile", missionId: "mission-a-write" },
        { suffix: "read", toolName: "readFile", missionId: "mission-b-read" },
      ];
      for (const entry of cases) {
        const owner = `secondary-${entry.suffix}`;
        const sequenceId = `sequence-${owner}`;
        const taskId = `task-mission-${entry.suffix}`;
        const missionId = entry.missionId;
        await runtime.taskSequenceManageController.publishSequence({
          ownerAgentInstanceId: owner,
          actor: { sourceKind: "user", actorId: "user-1" },
          sequenceId,
          firstTask: {
            taskId,
            title: "标签测试",
            priorityTier: 0,
            externalReference: null,
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
          missionId,
          mode: "assist",
          prompt: "标签测试",
          taskNodes: [
            {
              id: "T-001",
              description: "标签测试",
              dependsOn: [],
              taskType: "data",
              toolNames: [entry.toolName],
              assignedAgentId: null,
              status: "running",
              resultLocation: null,
            },
          ],
          taskSequenceIdentifier: sequenceId,
          originalTaskIdentifier: taskId,
        });
        await relationStore.upsert({
          missionIdentifier: missionId,
          projectIdentifier: "project-a",
          conversationIdentifier: "conversation-1",
          taskSequenceIdentifier: sequenceId,
          taskIdentifier: taskId,
          sequenceOwnerAgentInstanceIdentifier: owner,
        });
      }

      const report = await runtime.scanStartupRecovery();
      const writeView = report.views.find(
        (view) => view.missionIdentifier === "mission-a-write",
      );
      const readView = report.views.find(
        (view) => view.missionIdentifier === "mission-b-read",
      );
      expect(writeView?.labels).toContain("has-writes");
      expect(readView?.labels).toEqual(["normal"]);
      const writeSelected = report.selected.find(
        (entry) => entry.missionIdentifier === "mission-a-write",
      );
      expect(writeSelected?.requiresNotification).toBe(true);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
