/**
 * ALIGN-02-05（2026-11-08）：**崩溃后回归时，遗留的"已领取"必须能被正确核对**。
 *
 * 场景（真实崩溃路径）：进程 A 领取了序列任务（`running`）后崩溃 ⇒ 租约过期 ⇒
 * 进程 B 接管租约并恢复 mission。此时序列任务**仍停在 `running`**，
 * 而 `claimTask` 只接受 `pending` ⇒ 若不做核对，B 永远领不到该任务，
 * 派发循环每次都以"领取失败"跳过 —— 任务被静默搁死。
 *
 * 本文件钉住：
 * 1. `running` 且属主已死的领取必须可被**释放回 pending**（受控核对，而不是重新领取）；
 * 2. 释放后同一任务可以再次被领取（B 能真正继续执行）；
 * 3. 不能因为"清理遗留"就把**已完成/已阻塞**的任务打回 pending。
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

let temporaryDirectory: string;
let store: AgentTaskSequenceStore;
let manage: TaskSequenceManageController;
let status: TaskSequenceStatusController;

const owner = "secondary-agent-dead";
const sequenceId = `sequence-${owner}`;
const viewer = { sourceKind: "user" as const, actorId: "user-1" };

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-stale-claim-"));
  store = new AgentTaskSequenceStore({ baseDirectory: temporaryDirectory });
  manage = new TaskSequenceManageController(store);
  status = new TaskSequenceStatusController(store);
  await manage.publishSequence({
    ownerAgentInstanceId: owner,
    actor: viewer,
    sequenceId,
    firstTask: {
      taskId: "task-original",
      title: "原始用户任务",
      priorityTier: 0,
      externalReference: null,
    },
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5 });
});

async function statusOf(taskId: string): Promise<string | undefined> {
  const snapshot = await status.getSnapshot({
    ownerAgentInstanceId: owner,
    sequenceId,
    viewer,
  });
  return snapshot.nodes.find((node) => node.taskId === taskId)?.status;
}

describe("崩溃遗留领取的核对（ALIGN-02-05）", () => {
  it("进程 A 领取后崩溃：任务停在 running，新进程领不到（这就是要核对的现场）", async () => {
    expect(
      await manage.claimTask({
        ownerAgentInstanceId: owner,
        sequenceId,
        taskId: "task-original",
      }),
    ).toBe(true);
    expect(await statusOf("task-original")).toBe("running");

    /** 模拟"进程 A 已死、进程 B 尝试继续"：直接领取会被拒。 */
    expect(
      await manage.claimTask({
        ownerAgentInstanceId: owner,
        sequenceId,
        taskId: "task-original",
      }),
    ).toBe(false);
  });

  it("核对后可释放回 pending，并再次领取（新进程能真正继续）", async () => {
    await manage.claimTask({
      ownerAgentInstanceId: owner,
      sequenceId,
      taskId: "task-original",
    });
    const released = await manage.releaseClaim({
      ownerAgentInstanceId: owner,
      sequenceId,
      taskId: "task-original",
    });
    expect(released).toBe(true);
    expect(await statusOf("task-original")).toBe("pending");
    expect(
      await manage.claimTask({
        ownerAgentInstanceId: owner,
        sequenceId,
        taskId: "task-original",
      }),
    ).toBe(true);
    expect(await statusOf("task-original")).toBe("running");
  });

  it("已完成的任务不会被释放成待执行（不倒退）", async () => {
    await manage.claimTask({
      ownerAgentInstanceId: owner,
      sequenceId,
      taskId: "task-original",
    });
    const snapshot = await status.getSnapshot({
      ownerAgentInstanceId: owner,
      sequenceId,
      viewer,
    });
    await manage.transitionTaskStatus({
      ownerAgentInstanceId: owner,
      sequenceId,
      taskId: "task-original",
      nextStatus: "done",
      blockReason: null,
      expectedRevision: snapshot.revision,
      actor: viewer,
    });
    expect(await statusOf("task-original")).toBe("done");
    /** done 不是 running ⇒ 释放被拒（幂等、不倒退）。 */
    expect(
      await manage.releaseClaim({
        ownerAgentInstanceId: owner,
        sequenceId,
        taskId: "task-original",
      }),
    ).toBe(false);
    expect(await statusOf("task-original")).toBe("done");
  });
});
