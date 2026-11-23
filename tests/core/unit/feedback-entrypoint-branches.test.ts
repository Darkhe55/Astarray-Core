/**
 * D8（2026-11-23）：反馈进程入口的**失联与协议不兼容**分支。
 *
 * 用进程内 FakeParent 驱动 `runFeedbackProcessEntry`：
 * - 协议版本不兼容 ⇒ protocolError + 退出；
 * - 连续未收到心跳 ⇒ selfTermination(heartbeat-lost) + stderr + 退出。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeedbackIpcMessage } from "../../../packages/core/src/feedback-process/ipc-protocol.js";
import {
  runFeedbackProcessEntry,
  type ChildProcessLike,
} from "../../../packages/core/src/feedback-process/entrypoint.js";

const FEEDBACK_PROTOCOL_VERSION = 1;

class FakeParent implements ChildProcessLike {
  connected = true;
  pid = 4242;
  /** 2026-11-23：模拟"投递消息时与主进程发送失败"的传输异常。 */
  throwOnDeliver = false;
  sentMessages: FeedbackIpcMessage[] = [];
  messageListeners: Array<(message?: FeedbackIpcMessage) => void> = [];
  disconnectListeners: Array<() => void> = [];

  send(message: FeedbackIpcMessage): boolean {
    if (this.throwOnDeliver && message.type === "deliver") {
      throw new Error("IPC 不可写");
    }
    this.sentMessages.push(message);
    return true;
  }

  on(event: "message" | "disconnect", listener: (message?: FeedbackIpcMessage) => void): void {
    if (event === "message") {
      this.messageListeners.push(listener);
    } else {
      this.disconnectListeners.push(listener as () => void);
    }
  }

  emitMessage(message: FeedbackIpcMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  waitForSentMessage(
    predicate: (message: FeedbackIpcMessage) => boolean,
    timeoutMilliseconds: number,
    description: string,
  ): Promise<FeedbackIpcMessage> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMilliseconds;
      const poll = () => {
        const match = this.sentMessages.find(predicate);
        if (match !== undefined) {
          resolve(match);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`等待超时: ${description}`));
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
  }
}

let temporaryDirectory: string;
let fakeParent: FakeParent;
let exitRequests: number[];
let stderrLines: string[];

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-entry-branches-"));
  exitRequests = [];
  stderrLines = [];
  fakeParent = new FakeParent();
  runFeedbackProcessEntry(fakeParent, {
    defaultBaseDirectory: temporaryDirectory,
    processExit: (exitCode) => {
      exitRequests.push(exitCode);
    },
    writeStderr: (text) => {
      stderrLines.push(text);
    },
  });
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("反馈进程入口：异常分支", () => {
  it("① 协议版本不兼容 ⇒ protocolError 并退出（不进入 ready）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION + 1,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    const protocolError = await fakeParent.waitForSentMessage(
      (message) => message.type === "protocolError",
      2_000,
      "protocolError",
    );
    expect(protocolError).toMatchObject({
      type: "protocolError",
      errorCode: "feedback-protocol-mismatch",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(exitRequests).toContain(1);
    expect(fakeParent.sentMessages.some((message) => message.type === "ready")).toBe(false);
  });

  it("② 连续未收到心跳 ⇒ selfTermination(heartbeat-lost)、stderr 说明并退出", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 20,
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "ready",
      2_000,
      "ready",
    );
    const termination = await fakeParent.waitForSentMessage(
      (message) => message.type === "selfTermination",
      5_000,
      "selfTermination",
    );
    expect(termination).toMatchObject({ type: "selfTermination", reason: "heartbeat-lost" });
    expect(stderrLines.some((line) => line.includes("未收到主进程心跳"))).toBe(true);
    expect(exitRequests).toContain(1);
  });

  it("③ hello 后 shutdown ⇒ 清除心跳看门狗并回复 shutdownComplete", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage((message) => message.type === "ready", 2_000, "ready");
    /** 先入队一条消息，确保投递定时器存在（覆盖 shutdown 清理循环）。 */
    fakeParent.emitMessage({ type: "setAgentStatus", recipientId: "worker-a", status: "idle" });
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-shutdown-enqueue",
      message: {
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        messageId: "00000000-0000-4000-8000-000000000999",
        source: { sourceType: "agent", agentInstanceId: "worker-a", agentRole: "tertiary" },
        recipientId: "scheduler-1",
        priority: "success",
        createdAtIso: "2026-11-23T00:00:00.000Z",
        idempotencyKey: "mission-1/scheduler-1/999",
        payload: { kind: "success", summary: "一条消息" },
      },
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "enqueued" && message.requestId === "req-shutdown-enqueue",
      2_000,
      "enqueued",
    );
    fakeParent.emitMessage({ type: "shutdown", requestId: "req-shutdown" });
    const complete = await fakeParent.waitForSentMessage(
      (message) => message.type === "shutdownComplete",
      2_000,
      "shutdownComplete",
    );
    expect(complete).toMatchObject({ type: "shutdownComplete", requestId: "req-shutdown" });
  });

  it("④ 投递时与主进程发送失败 ⇒ 记录 stderr 且不崩溃（等待重试）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage((message) => message.type === "ready", 2_000, "ready");
    fakeParent.emitMessage({
      type: "setAgentStatus",
      recipientId: "worker-a",
      status: "idle",
    });
    fakeParent.throwOnDeliver = true;
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-deliver-fail",
      message: {
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        messageId: "00000000-0000-4000-8000-000000000777",
        source: { sourceType: "agent", agentInstanceId: "worker-a", agentRole: "tertiary" },
        recipientId: "scheduler-1",
        priority: "success",
        createdAtIso: "2026-11-23T00:00:00.000Z",
        idempotencyKey: "mission-1/scheduler-1/777",
        payload: { kind: "success", summary: "一条消息" },
      },
    });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !stderrLines.some((line) => line.includes("投递失败"))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(stderrLines.some((line) => line.includes("投递失败"))).toBe(true);
  });

  it("⑤ 邮箱目录不可写 ⇒ enqueued 拒绝为 journal-unavailable", async () => {
    const blockedPath = path.join(temporaryDirectory, "blocked-by-file");
    await fs.writeFile(blockedPath, "not a directory", "utf8");
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: blockedPath,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage((message) => message.type === "ready", 2_000, "ready");
    fakeParent.emitMessage({ type: "setAgentStatus", recipientId: "worker-a", status: "idle" });
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-journal-fail",
      message: {
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        messageId: "00000000-0000-4000-8000-000000000888",
        source: { sourceType: "agent", agentInstanceId: "worker-a", agentRole: "tertiary" },
        recipientId: "scheduler-1",
        priority: "success",
        createdAtIso: "2026-11-23T00:00:00.000Z",
        idempotencyKey: "mission-1/scheduler-1/888",
        payload: { kind: "success", summary: "一条消息" },
      },
    });
    const enqueued = await fakeParent.waitForSentMessage(
      (message) => message.type === "enqueued" && message.requestId === "req-journal-fail",
      3_000,
      "enqueued",
    );
    expect(enqueued).toMatchObject({ accepted: false, rejectionCode: "journal-unavailable" });
  });

  it("⑥ 回复消息走子进程回复路由守卫（解析任务 → 拒绝未知原消息）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage((message) => message.type === "ready", 2_000, "ready");
    fakeParent.emitMessage({ type: "setAgentStatus", recipientId: "worker-a", status: "idle" });
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-reply-guard",
      message: {
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        messageId: "00000000-0000-4000-8000-000000001001",
        source: { sourceType: "agent", agentInstanceId: "worker-a", agentRole: "tertiary" },
        recipientId: "scheduler-1",
        priority: "success",
        createdAtIso: "2026-11-23T00:00:00.000Z",
        idempotencyKey: "mission-1/scheduler-1/1001",
        replyToMessageIdentifier: "00000000-0000-4000-8000-000000001000",
        payload: { kind: "success", summary: "回复" },
      },
    });
    const enqueued = await fakeParent.waitForSentMessage(
      (message) => message.type === "enqueued" && message.requestId === "req-reply-guard",
      3_000,
      "enqueued",
    );
    expect(enqueued).toMatchObject({ accepted: false });
  });

  it("⑦ 收件人忙碌 ⇒ 投递退避定时器存在；shutdown 清理它", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage((message) => message.type === "ready", 2_000, "ready");
    fakeParent.emitMessage({ type: "setAgentStatus", recipientId: "worker-busy", status: "busy" });
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-busy",
      message: {
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        messageId: "00000000-0000-4000-8000-000000001101",
        source: { sourceType: "agent", agentInstanceId: "worker-a", agentRole: "tertiary" },
        recipientId: "worker-busy",
        priority: "success",
        createdAtIso: "2026-11-23T00:00:00.000Z",
        idempotencyKey: "mission-1/worker-busy/1101",
        payload: { kind: "success", summary: "一条消息" },
      },
    });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "enqueued" && message.requestId === "req-busy",
      2_000,
      "enqueued",
    );
    fakeParent.emitMessage({ type: "shutdown", requestId: "req-shutdown-busy" });
    const complete = await fakeParent.waitForSentMessage(
      (message) => message.type === "shutdownComplete" && message.requestId === "req-shutdown-busy",
      2_000,
      "shutdownComplete",
    );
    expect(complete).toMatchObject({ type: "shutdownComplete" });
  });

  it("⑧ 回复已投递消息 ⇒ 子进程回复路由守卫解析任务（覆盖 resolveTask 分支）", async () => {
    fakeParent.emitMessage({
      type: "hello",
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      baseDirectory: temporaryDirectory,
      heartbeatTimeoutMilliseconds: 30_000,
    });
    await fakeParent.waitForSentMessage((message) => message.type === "ready", 2_000, "ready");
    fakeParent.emitMessage({ type: "setAgentStatus", recipientId: "worker-a", status: "idle" });
    const original = {
      protocolVersion: FEEDBACK_PROTOCOL_VERSION,
      messageId: "00000000-0000-4000-8000-000000001201",
      source: { sourceType: "agent" as const, agentInstanceId: "worker-a", agentRole: "tertiary" as const },
      recipientId: "worker-a",
      priority: "success" as const,
      createdAtIso: "2026-11-23T00:00:00.000Z",
      idempotencyKey: "mission-x/worker-a/1201",
      missionIdentifier: "mission-x",
      taskIdentifier: "T-x",
      payload: { kind: "success" as const, summary: "原件" },
    };
    fakeParent.emitMessage({ type: "enqueue", requestId: "req-original", message: original });
    await fakeParent.waitForSentMessage(
      (message) => message.type === "deliver" && message.message.messageId === original.messageId,
      3_000,
      "原始投递",
    );
    fakeParent.emitMessage({
      type: "enqueue",
      requestId: "req-reply-real",
      message: {
        ...original,
        messageId: "00000000-0000-4000-8000-000000001202",
        idempotencyKey: "mission-x/worker-a/1202",
        replyToMessageIdentifier: original.messageId,
        recipientId: "scheduler-1",
        payload: { kind: "success", summary: "回复原件" },
      },
    });
    const enqueued = await fakeParent.waitForSentMessage(
      (message) => message.type === "enqueued" && message.requestId === "req-reply-real",
      3_000,
      "enqueued",
    );
    expect(enqueued).toMatchObject({ accepted: false });
  });
});
