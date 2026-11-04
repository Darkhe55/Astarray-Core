/**
 * ALIGN-02-06（2026-11-05）：运行中插入。
 *
 * 目标：安全点插入成功后，任务同时出现在 mission 任务链与**权威序列**；
 * 无法插入时推迟并登记到序列（不丢任务）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import { DeferredInsertionQueueStore } from "../../../packages/core/src/orchestration/deferred-insertion-queue.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("ALIGN-02 运行中插入", () => {
  it("安全点插入：mission 链与权威序列都出现该任务", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-insert-"));
    directories.push(stateDirectory);
    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      /** 0 并发：任务保持 pending，mission 仍 running ⇒ 安全点（无 running 任务）。 */
      concurrency: 0,
      failureThreshold: 1,
      maxLoopIterations: 8,
      runtimeKind: "mock",
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      streamOutput: () => {},
    });
    try {
      const missionId = await runtime.controller.handleUserMessage("插入测试", {
        projectIdentifier: "project-a",
      });
      const deadline = Date.now() + 10_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (
        (status?.summary?.status !== "running" || !status?.taskChain) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      expect(status?.summary?.status).toBe("running");
      const sequenceId = String(status?.summary?.taskSequenceIdentifier);
      const ownerAgentInstanceId = sequenceId.slice("sequence-".length);
      const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
      const before = await store.readSequence(ownerAgentInstanceId, sequenceId);
      expect(before).not.toBeNull();

      const outcome = await runtime.controller.requestRuntimeTaskInsertion({
        missionIdentifier: missionId,
        requestIdentifier: "insert-request-1",
        expectedGroupRevision: before?.revision ?? 0,
        anchorTaskIdentifier: null,
        title: "插入的任务",
        description: "运行中插入",
        acceptanceCriteria: "完成",
        dependsOn: [],
      });
      expect(outcome.outcome, outcome.reason).toBe("inserted");
      const insertedTaskIdentifier = outcome.taskIdentifier;
      expect(typeof insertedTaskIdentifier).toBe("string");

      const after = await store.readSequence(ownerAgentInstanceId, sequenceId);
      expect(
        after?.nodes.some((node) => node.taskId === insertedTaskIdentifier),
      ).toBe(true);
      const duplicate = await runtime.controller.requestRuntimeTaskInsertion({
        missionIdentifier: missionId,
        requestIdentifier: "insert-request-1",
        expectedGroupRevision: after?.revision ?? 0,
        anchorTaskIdentifier: null,
        title: "插入的任务",
        description: "运行中插入",
        acceptanceCriteria: "完成",
        dependsOn: [],
      });
      expect(duplicate.outcome).toBe("duplicate");
      const afterDuplicate = await store.readSequence(ownerAgentInstanceId, sequenceId);
      expect(
        afterDuplicate?.nodes.filter((node) =>
          String(node.taskId).startsWith("task-runtime-insert-"),
        ).length,
      ).toBe(1);

      const missionStatus = await runtime.controller.queryMissionStatus(missionId);
      expect(
        missionStatus?.taskChain?.tasks.some(
          (task) => task.id === insertedTaskIdentifier,
        ),
      ).toBe(true);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});

  it("组已关闭时推迟：登记到序列并进入推迟队列", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-align02-defer-"));
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
    });
    try {
      const missionId = await runtime.controller.handleUserMessage("推迟插入", {
        projectIdentifier: "project-a",
      });
      const deadline = Date.now() + 20_000;
      let status = await runtime.controller.queryMissionStatus(missionId);
      while (status?.summary?.status !== "done" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await runtime.controller.queryMissionStatus(missionId);
      }
      expect(status?.summary?.status).toBe("done");

      const sequenceId = String(status?.summary?.taskSequenceIdentifier);
      const ownerAgentInstanceId = sequenceId.slice("sequence-".length);
      const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
      const before = await store.readSequence(ownerAgentInstanceId, sequenceId);
      expect(before).not.toBeNull();

      const outcome = await runtime.controller.requestRuntimeTaskInsertion({
        missionIdentifier: missionId,
        requestIdentifier: "deferred-request-1",
        expectedGroupRevision: before?.revision ?? 0,
        anchorTaskIdentifier: null,
        title: "推迟的任务",
        description: "组已关闭",
        acceptanceCriteria: "完成",
        dependsOn: [],
      });
      expect(outcome.outcome, outcome.reason).toBe("deferred-to-sequence");
      const deferredTaskIdentifier = outcome.taskIdentifier;
      expect(typeof deferredTaskIdentifier).toBe("string");

      const after = await store.readSequence(ownerAgentInstanceId, sequenceId);
      expect(
        after?.nodes.some((node) => node.taskId === deferredTaskIdentifier),
      ).toBe(true);
      const queue = new DeferredInsertionQueueStore({ baseDirectory: stateDirectory });
      const pending = await queue.listPending(missionId);
      expect(
        pending.some((entry) => entry.taskIdentifier === deferredTaskIdentifier),
      ).toBe(true);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
