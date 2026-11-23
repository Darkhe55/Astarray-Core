/**
 * D4（2026-11-23 产品裁决）：**任务定义版本与执行尝试分别记录**。
 *
 * - `executionAttempt`：权威派发器逐次递增并落盘（已有用例）；
 * - `taskRevision`：派发时的任务链 revision，随反馈信封盖章；
 * - 调度器维护"最近落盘 revision"，缺省从初始链读取，避免额外读盘。
 */
import { describe, expect, it } from "vitest";

import { DagScheduler } from "../../../packages/core/src/orchestration/dag-scheduler.js";
import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";

function chain(revision: number): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "m-1",
    revision,
    updatedAtIso: "2026-11-23T00:00:00.000Z",
    tasks: [
      {
        id: "T-1",
        description: "任务",
        dependsOn: [],
        taskType: "data",
        toolNames: ["readFile"],
        assignedAgentId: "w1",
        status: "pending",
        resultLocation: null,
      },
    ],
  };
}

function schedulerWith(initialRevision: number, updateTaskChain: (missionId: string, updater: (current: TaskChainDocument | null) => TaskChainDocument) => Promise<TaskChainDocument>) {
  return new DagScheduler(chain(initialRevision), {
    missionId: "m-1",
    concurrency: 1,
    taskStore: { updateTaskChain } as never,
    allocateAgentId: () => "agent-1",
    onTaskFinished: async () => {},
  } as never);
}

describe("D4：任务链 revision 随派发记录", () => {
  it("① 初始 revision 从链读取", () => {
    const scheduler = schedulerWith(7, async () => chain(8));
    expect(scheduler.getChainRevision()).toBe(7);
  });

  it("② 落盘后更新为写入返回的 revision", async () => {
    const scheduler = schedulerWith(1, async (missionId, updater) => {
      const next = updater(chain(1));
      expect(missionId).toBe("m-1");
      return next;
    });
    const attempt = await scheduler.noteDispatchAttempt("T-1");
    expect(attempt).toBe(1);
    expect(scheduler.getChainRevision()).toBe(2);
  });

  it("③ 只读测试端口（无 updateTaskChain 返回值）⇒ revision 保持原值（不猜）", async () => {
    const scheduler = schedulerWith(5, async () => undefined as never);
    await scheduler.noteDispatchAttempt("T-1");
    expect(scheduler.getChainRevision()).toBe(5);
  });
});
