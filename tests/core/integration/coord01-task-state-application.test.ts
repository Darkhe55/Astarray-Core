/**
 * 检查点 2 第二步：消费结果 → **权威任务链**（2026-11-16）。
 *
 * 反例要点：
 * - 成功消息把任务推到 done，并**递增 revision**（不覆盖并发写者）；
 * - 不认识的消息类型不动任务（不猜状态）；
 * - 找不到任务 ⇒ task-not-found（不新建、不改别的任务）；
 * - 已是目标状态 ⇒ 不写盘（幂等重放不产生无意义 revision）。
 */
import { describe, expect, it, vi } from "vitest";

import type { TaskChainDocument } from "../../../packages/core/src/core/types.js";
import { applyCoordinationMessageToTaskState } from "../../../packages/core/src/orchestration/coordination-task-state.js";

function buildChain(status: "pending" | "running" | "done" = "running"): TaskChainDocument {
  return {
    schemaVersion: 1,
    missionId: "mission-1",
    revision: 3,
    updatedAtIso: "2026-11-16T00:00:00.000Z",
    tasks: [
      {
        id: "T-001",
        description: "执行",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
        status,
        assignedAgentId: "worker-1",
        resultLocation: null,
      } as never,
    ],
  };
}

function buildStore(chain: TaskChainDocument | null) {
  let current = chain;
  return {
    readTaskChain: vi.fn(async () => current),
    updateTaskChain: vi.fn(async (_missionId: string, updater: (c: TaskChainDocument | null) => TaskChainDocument) => {
      const next = updater(current);
      current = next;
      return next;
    }),
    getCurrent: () => current,
  };
}

describe("协调消息 → 权威任务状态", () => {
  it("① 成功消息 ⇒ 任务 done，revision 递增", async () => {
    const store = buildStore(buildChain("running"));
    const result = await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: { messageIdentifier: "m-1", taskIdentifier: "T-001", payload: { kind: "success" } },
      completionAuthorization: {
        code: "authoritative-completion-accepted",
        decidedAtIso: "2026-11-16T00:00:00.000Z",
      },
    });
    expect(result).toMatchObject({
      outcome: "applied",
      missionIdentifier: "mission-1",
      taskStatus: "done",
    });
    expect(store.getCurrent()?.revision).toBe(4);
    expect(store.getCurrent()?.tasks[0]?.status).toBe("done");
  });

  it("② 澄清请求等未知类型 ⇒ 不改任务状态、不写盘", async () => {
    const store = buildStore(buildChain("running"));
    const result = await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: {
        messageIdentifier: "m-2",
        taskIdentifier: "T-001",
        payload: { kind: "clarification-request" },
      },
    });
    expect(result.outcome).toBe("status-unchanged");
    expect(store.updateTaskChain).not.toHaveBeenCalled();
  });

  it("③ 任务不在任何任务链里 ⇒ task-not-found（不新建任务）", async () => {
    const store = buildStore(buildChain("running"));
    const result = await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: { messageIdentifier: "m-3", taskIdentifier: "T-999", payload: { kind: "success" } },
      completionAuthorization: {
        code: "authoritative-completion-accepted",
        decidedAtIso: "2026-11-16T00:00:00.000Z",
      },
    });
    expect(result.outcome).toBe("task-not-found");
    expect(store.updateTaskChain).not.toHaveBeenCalled();
  });

  it("④ 已是目标状态 ⇒ 不写盘（幂等重放不制造 revision 抖动）", async () => {
    const store = buildStore(buildChain("done"));
    const result = await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: { messageIdentifier: "m-4", taskIdentifier: "T-001", payload: { kind: "success" } },
      completionAuthorization: {
        code: "authoritative-completion-accepted",
        decidedAtIso: "2026-11-16T00:00:00.000Z",
      },
    });
    expect(result.outcome).toBe("status-unchanged");
    expect(store.updateTaskChain).not.toHaveBeenCalled();
    expect(store.getCurrent()?.revision).toBe(3);
  });
});

describe("阻塞不由消息决定（2026-11-16 修正）", () => {
  it("⑤ payload.kind 为 blocked ⇒ 不改任务状态（该载荷类型根本不存在）", async () => {
    const store = buildStore(buildChain("running"));
    const result = await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: { messageIdentifier: "m-5", taskIdentifier: "T-001", payload: { kind: "blocked" } },
    });
    expect(result.outcome).toBe("status-unchanged");
    expect(result.taskStatus).toBeNull();
    expect(store.updateTaskChain).not.toHaveBeenCalled();
  });

  it("⑥ 失败消息 ⇒ failed（与 done 分开映射）", async () => {
    const store = buildStore(buildChain("running"));
    const result = await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: { messageIdentifier: "m-6", taskIdentifier: "T-001", payload: { kind: "failure" } },
    });
    expect(result).toMatchObject({ outcome: "applied", taskStatus: "failed" });
    expect(store.getCurrent()?.tasks[0]?.status).toBe("failed");
  });
});

describe("WIRING-04-03：非活动 mission 的 done 需要受控凭证", () => {
  it("① 无凭证的 done ⇒ 抛错且不改任务链", async () => {
    const chain = buildChain("running");
    const store = buildStore(chain);
    await expect(
      applyCoordinationMessageToTaskState({
        taskStore: store as never,
        missionIdentifiers: ["mission-1"],
        message: {
          messageIdentifier: "message-done-1",
          taskIdentifier: "T-001",
          payload: { kind: "success", summary: "完成" },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "completion-not-authorized" });
    expect(store.updateTaskChain).not.toHaveBeenCalled();
  }, 30_000);

  it("② 带凭证的 done ⇒ 正常写链；failed 不需要凭证", async () => {
    const chain = buildChain("running");
    const store = buildStore(chain);
    const applied = await applyCoordinationMessageToTaskState({
      taskStore: store as never,
      missionIdentifiers: ["mission-1"],
      message: {
        messageIdentifier: "message-done-2",
        taskIdentifier: "T-001",
        payload: { kind: "success", summary: "完成" },
      },
      completionAuthorization: {
        code: "authoritative-completion-accepted",
        decidedAtIso: "2026-11-17T00:00:00.000Z",
      },
    });
    expect(applied.outcome).toBe("applied");

    const failureStore = buildStore(buildChain("running"));
    const failed = await applyCoordinationMessageToTaskState({
      taskStore: failureStore as never,
      missionIdentifiers: ["mission-1"],
      message: {
        messageIdentifier: "message-failed-1",
        taskIdentifier: "T-001",
        payload: { kind: "failure", summary: "失败" },
      },
    });
    expect(failed.outcome).toBe("applied");
  }, 30_000);
});
