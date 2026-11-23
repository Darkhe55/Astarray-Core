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
  sentMessages: FeedbackIpcMessage[] = [];
  messageListeners: Array<(message?: FeedbackIpcMessage) => void> = [];
  disconnectListeners: Array<() => void> = [];

  send(message: FeedbackIpcMessage): boolean {
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
});
