/**
 * B10（2026-11-24）：反馈进程入口的**故障注入**与关闭清理。
 *
 * 生产代码已把 journal/worker 构造与投递定时器变为可注入：
 * - 初始化失败（DomainError / 普通 Error）⇒ protocolError 携带正确 errorCode + exit(1)；
 * - 子进程侧回复路由守卫确实读任务链并能给出兜底收件人；
 * - 关闭时清理待触发的重投定时器；定时器触发时投递步骤真的执行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import type { FeedbackIpcMessage } from "../../../packages/core/src/feedback-process/ipc-protocol.js";
import {
  runFeedbackProcessEntry,
  type ChildProcessLike,
} from "../../../packages/core/src/feedback-process/entrypoint.js";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";

const PROTOCOL_VERSION = 1;

class FakeParent implements ChildProcessLike {
  connected = true;
  pid = 1111;
  sentMessages: FeedbackIpcMessage[] = [];
  private listeners: Array<(message?: FeedbackIpcMessage) => void> = [];

  send(message: FeedbackIpcMessage): boolean {
    this.sentMessages.push(message);
    return true;
  }

  on(event: "message" | "disconnect", listener: (message?: FeedbackIpcMessage) => void): void {
    if (event === "message") {
      this.listeners.push(listener);
    }
  }

  emit(message: FeedbackIpcMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  async waitFor(
    predicate: (message: FeedbackIpcMessage) => boolean,
    description: string,
  ): Promise<FeedbackIpcMessage> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const match = this.sentMessages.find(predicate);
      if (match !== undefined) {
        return match;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`等待超时: ${description}`);
  }
}

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-entry-refactor-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function validFeedbackMessage(): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: "00000000-0000-4000-8000-000000000001",
    source: { sourceType: "agent", agentInstanceId: "agent-1", agentRole: "tertiary" },
    recipientId: "scheduler:m-1",
    priority: "success",
    createdAtIso: "2026-11-24T00:00:00.000Z",
    idempotencyKey: "m-1/T-1/1",
    payload: { kind: "success", summary: "完成" },
  };
}

function hello(parent: FakeParent): void {
  parent.emit({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    baseDirectory: temporaryDirectory,
    heartbeatTimeoutMilliseconds: 30_000,
  });
}

describe("B10：初始化故障注入", () => {
  it("① journal 构造抛 DomainError ⇒ protocolError 带原始 errorCode + exit(1)", async () => {
    const parent = new FakeParent();
    const exitCodes: number[] = [];
    runFeedbackProcessEntry(parent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: (code) => exitCodes.push(code),
      writeStderr: () => {},
      createJournal: () => {
        throw new DomainError("invalid-task-chain", "注入的构造失败");
      },
    });
    hello(parent);
    const error = await parent.waitFor((message) => message.type === "protocolError", "protocolError");
    expect(error).toMatchObject({
      type: "protocolError",
      errorCode: "invalid-task-chain",
    });
    expect(exitCodes).toEqual([1]);
  });

  it("② journal 构造抛普通 Error ⇒ errorCode=unknown + exit(1)", async () => {
    const parent = new FakeParent();
    const exitCodes: number[] = [];
    runFeedbackProcessEntry(parent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: (code) => exitCodes.push(code),
      writeStderr: () => {},
      createJournal: () => {
        throw new Error("非 DomainError");
      },
    });
    hello(parent);
    const error = await parent.waitFor((message) => message.type === "protocolError", "protocolError");
    expect(error).toMatchObject({ type: "protocolError", errorCode: "unknown" });
    expect(exitCodes).toEqual([1]);
  });

  it("③ 子进程侧回复路由守卫：读任务链并给出兜底收件人", async () => {
    const parent = new FakeParent();
    interface CapturedGuard {
      (input: {
        message: FeedbackMessage;
        findDeliveredMessage: (messageIdentifier: string) => Promise<{
          messageId: string;
          recipientId: string;
          taskIdentifier?: string;
          source: { sourceType: "agent"; agentInstanceId: string };
        } | null>;
      }): Promise<void>;
    }
    /** 用对象承载：闭包内赋值不会被 TS 的控制流收窄成 never。 */
    const captured: { guard: CapturedGuard | null } = { guard: null };
    runFeedbackProcessEntry(parent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: () => {},
      writeStderr: () => {},
      createJournal: (input) => {
        captured.guard = input.replyRoutingGuard as unknown as CapturedGuard;
        throw new DomainError("invalid-task-chain", "本用例只验证守卫装配");
      },
    });
    const missionDirectory = path.join(temporaryDirectory, "missions", "m-1");
    await fs.mkdir(missionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(missionDirectory, "task-chain.json"),
      JSON.stringify({
        schemaVersion: 1,
        missionId: "m-1",
        revision: 1,
        updatedAtIso: "2026-11-24T00:00:00.000Z",
        tasks: [
          {
            id: "T-1",
            description: "任务",
            dependsOn: [],
            taskType: "data",
            toolNames: [],
            assignedAgentId: null,
            status: "pending",
            resultLocation: null,
          },
        ],
      }),
      "utf8",
    );
    hello(parent);
    await parent.waitFor((message) => message.type === "protocolError", "protocolError");
    expect(captured.guard).not.toBeNull();
    const guard = captured.guard as CapturedGuard;
    /** 回复消息：带 replyTo + 任务标识 ⇒ 守卫会读任务链并计算兜底收件人。 */
    const replyMessage: FeedbackMessage = {
      ...validFeedbackMessage(),
      messageId: "00000000-0000-4000-8000-000000000002",
      replyToMessageIdentifier: "00000000-0000-4000-8000-000000000099",
      taskIdentifier: "T-1",
      missionIdentifier: "m-1",
    };
    /** 任务链里的任务没有发布者 ⇒ 守卫必须拒绝（不接受回退推断）。 */
    await expect(
      guard({
        message: replyMessage,
        findDeliveredMessage: async () => ({
          messageId: replyMessage.replyToMessageIdentifier!,
          recipientId: "agent-1",
          taskIdentifier: "T-1",
          source: { sourceType: "agent", agentInstanceId: "agent-9" },
        }),
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
  });
});

describe("B10：投递定时器与关闭清理", () => {
  it("④ 入队后创建定时器；关闭时清理待触发定时器", async () => {
    const parent = new FakeParent();
    const cleared: unknown[] = [];
    const scheduled: Array<() => void> = [];
    runFeedbackProcessEntry(parent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: () => {},
      writeStderr: () => {},
      scheduleDeliveryTimer: (callback) => {
        scheduled.push(callback);
        return { handle: "fake-timer" } as unknown as NodeJS.Timeout;
      },
      clearDeliveryTimer: (timer) => {
        cleared.push(timer);
      },
    });
    hello(parent);
    await parent.waitFor((message) => message.type === "ready", "ready");
    parent.emit({ type: "setAgentStatus", recipientId: "agent-1", status: "idle" });
    parent.emit({
      type: "enqueue",
      requestId: "r-1",
      message: validFeedbackMessage(),
    });
    await parent.waitFor((message) => message.type === "enqueued", "enqueued");
    expect(scheduled.length).toBe(1);

    parent.emit({ type: "shutdown", requestId: "r-2" });
    await parent.waitFor((message) => message.type === "shutdownComplete", "shutdownComplete");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toEqual({ handle: "fake-timer" });
  });

  it("⑤ 定时器触发 ⇒ 投递步骤真的执行（投递消息发给主进程）", async () => {
    const parent = new FakeParent();
    const scheduled: Array<() => void> = [];
    runFeedbackProcessEntry(parent, {
      defaultBaseDirectory: temporaryDirectory,
      processExit: () => {},
      writeStderr: () => {},
      scheduleDeliveryTimer: (callback) => {
        scheduled.push(callback);
        return { handle: "fake-timer" } as unknown as NodeJS.Timeout;
      },
      clearDeliveryTimer: () => {},
    });
    hello(parent);
    await parent.waitFor((message) => message.type === "ready", "ready");
    parent.emit({ type: "setAgentStatus", recipientId: "agent-1", status: "idle" });
    parent.emit({ type: "enqueue", requestId: "r-1", message: validFeedbackMessage() });
    await parent.waitFor((message) => message.type === "enqueued", "enqueued");
    const callback = scheduled[0];
    expect(callback).toBeDefined();
    callback!();
    const delivered = await parent.waitFor((message) => message.type === "deliver", "deliver");
    expect(delivered).toMatchObject({
      type: "deliver",
      message: { messageId: validFeedbackMessage().messageId },
    });
  });
});
