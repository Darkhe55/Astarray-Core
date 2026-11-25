/**
 * B9（2026-11-25）：任务序列管理控制器的权限/幂等/并发守卫。
 *
 * 纪律：actor 不得越权管理他人序列；同任务幂等不重复插入；领取不抢占、不重试。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import {
  TaskSequenceManageController,
  TaskSequenceStatusController,
} from "../../../packages/core/src/orchestration/task-sequence-controllers.js";

let baseDirectory: string;
let store: AgentTaskSequenceStore;
let manage: TaskSequenceManageController;
let status: TaskSequenceStatusController;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-seq-ctl-"));
  store = new AgentTaskSequenceStore({ baseDirectory });
  manage = new TaskSequenceManageController(store);
  status = new TaskSequenceStatusController(store);
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const userActor = { sourceKind: "user" as const, actorId: "user-1" };

async function publishOne(sequenceId = "seq-1", taskId = "T-1"): Promise<void> {
  await manage.publishSequence({
    ownerAgentInstanceId: "agent-1",
    actor: userActor,
    sequenceId,
    firstTask: { taskId, title: "首个任务", priorityTier: null, externalReference: "ref-1" },
  } as never);
}

describe("B9：任务序列管理控制器", () => {
  it("① actor 越权（agent 管理他人序列）⇒ 拒绝；用户来源允许", async () => {
    await expect(
      manage.publishSequence({
        ownerAgentInstanceId: "agent-1",
        actor: { sourceKind: "agent", actorId: "agent-2" },
        sequenceId: "seq-1",
        firstTask: { taskId: "T-1", title: "任务", priorityTier: null, externalReference: "ref-1" },
      } as never),
    ).rejects.toThrow();

    await expect(publishOne()).resolves.toBeUndefined();
  });

  it("② 重复发布同一序列 ⇒ invalid-task-chain（不覆盖既有序列）", async () => {
    await publishOne();
    await expect(publishOne("seq-1", "T-2")).rejects.toMatchObject({
      errorCode: "invalid-task-chain",
    });
  });

  it("③ publishOrInsertTask：序列不存在 ⇒ 创建；已存在同 taskId ⇒ 幂等返回且 revision 不变", async () => {
    const created = await manage.publishOrInsertTask({
      ownerAgentInstanceId: "agent-1",
      actor: userActor,
      sequenceId: "seq-2",
      task: { taskId: "T-1", title: "任务", priorityTier: null, externalReference: "ref-1" },
      anchor: { predecessorTaskIds: [], successorTaskIds: [] },
    } as never);
    expect(created.isSequenceCreated).toBe(true);
    const revisionAfterCreate = created.document.revision;

    const replay = await manage.publishOrInsertTask({
      ownerAgentInstanceId: "agent-1",
      actor: userActor,
      sequenceId: "seq-2",
      task: { taskId: "T-1", title: "任务", priorityTier: null, externalReference: "ref-1" },
      anchor: { predecessorTaskIds: [], successorTaskIds: [] },
    } as never);
    expect(replay.isSequenceCreated).toBe(false);
    expect(replay.document.revision).toBe(revisionAfterCreate);
  });

  it("④ claimTask：非 pending ⇒ false；正常 pending ⇒ true 且状态 running", async () => {
    await publishOne("seq-3", "T-1");
    const claimed = await manage.claimTask({
      ownerAgentInstanceId: "agent-1",
      sequenceId: "seq-3",
      taskId: "T-1",
      expectedRevision: 1,
      actor: userActor,
    } as never);
    expect(claimed).toBe(true);

    const secondClaim = await manage.claimTask({
      ownerAgentInstanceId: "agent-1",
      sequenceId: "seq-3",
      taskId: "T-1",
      expectedRevision: 2,
      actor: userActor,
    } as never);
    /** 已领走 ⇒ 不得二次领取。 */
    expect(secondClaim).toBe(false);

    const snapshot = await status.getSnapshot({
      ownerAgentInstanceId: "agent-1",
      sequenceId: "seq-3",
      viewer: userActor,
    } as never);
    expect(snapshot.nodes[0]?.status).toBe("running");
  });

  it("⑤ transitionTaskStatus：非法目标状态 ⇒ 拒绝（不写入）", async () => {
    await publishOne("seq-4", "T-1");
    const outcome = await manage
      .transitionTaskStatus({
        ownerAgentInstanceId: "agent-1",
        sequenceId: "seq-4",
        taskId: "T-1",
        nextStatus: "not-a-status",
        blockReason: null,
        expectedRevision: 1,
        actor: userActor,
      } as never)
      .catch((error: Error) => error);
    expect(outcome).toBeInstanceOf(Error);
  });

  it("⑥ 快照：未知序列 ⇒ 抛错或空文档（不伪造节点）", async () => {
    const outcome = await status
      .getSnapshot({
        ownerAgentInstanceId: "agent-1",
        sequenceId: "seq-missing",
        viewer: userActor,
      } as never)
      .catch((error: Error) => error);
    if (outcome instanceof Error) return;
    expect(outcome.nodes).toEqual([]);
  });
});
