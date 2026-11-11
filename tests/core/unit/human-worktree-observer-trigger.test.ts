/**
 * REPAIR（HumanWorktreeObserver）：agent 写文件前**自动触发**观察。
 *
 * 反例：观察失败不得阻塞写入（观察是旁路证据，不是写入门禁）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentEditIntentGuard } from "../../../packages/core/src/orchestration/agent-edit-intent-guard.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "guard-observer-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("AgentEditIntentGuard 触发人工工作树观察", () => {
  it("记录自写前调用观察器，标识带任务前缀", async () => {
    const observeWorktree = vi.fn(async (_input: { observationIdentifier: string }) => ({ ok: true }));
    const guard = new AgentEditIntentGuard({ baseDirectory, worktreeObserver: { observeWorktree } });
    await guard
      .recordOwnWrite({
        agentInstanceId: "worker-1",
        taskExecutionIdentifier: "T-001",
        filePath: path.join(baseDirectory, "a.txt"),
        writtenContentSha256: "abc",
      } as never)
      .catch(() => undefined);
    expect(observeWorktree).toHaveBeenCalledTimes(1);
    expect(observeWorktree.mock.calls[0]![0]).toMatchObject({
      observationIdentifier: "agent-write:T-001",
    });
  });

  it("观察失败**不阻塞**写入（旁路证据不得成为门禁）", async () => {
    const guard = new AgentEditIntentGuard({
      baseDirectory,
      worktreeObserver: {
        observeWorktree: async () => {
          throw new Error("observe-boom");
        },
      },
    });
    /** 记录自写本身可能因缺少基线而拒绝；关键断言是**拒绝原因不是观察失败**。 */
    const error = await guard
      .recordOwnWrite({
        agentInstanceId: "worker-1",
        taskExecutionIdentifier: "T-001",
        filePath: path.join(baseDirectory, "a.txt"),
        writtenContentSha256: "abc",
      } as never)
      .then(() => null)
      .catch((caught: unknown) => caught as Error);
    expect(String(error?.message ?? "")).not.toContain("observe-boom");
  });

  it("未注入观察器 ⇒ 行为不变（不调用、不报错）", async () => {
    const guard = new AgentEditIntentGuard({ baseDirectory });
    /** 未注入时不因观察而抛错（其余行为与既有实现一致）。 */
    const error = await guard
      .recordOwnWrite({
        agentInstanceId: "worker-1",
        taskExecutionIdentifier: null,
        filePath: path.join(baseDirectory, "a.txt"),
        writtenContentSha256: "abc",
      } as never)
      .then(() => null)
      .catch((caught: unknown) => caught as Error);
    expect(String(error?.message ?? "")).not.toContain("observe");
  });
});
