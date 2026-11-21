/**
 * 2026-11-21（用户裁决 C）：`feedback-outbox` CLI（死信人工入口）。
 *
 * 覆盖：空清单不伪造；list 只读；requeue 写回补送并删除死信；remove 清除；
 * 未知文件 ⇒ 退出码 1；非法文件名 ⇒ 退出码 2。
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeFeedbackOutboxListCommand,
  executeFeedbackOutboxRemoveCommand,
  executeFeedbackOutboxRequeueCommand,
} from "../../../packages/tui/src/cli/feedback-outbox-command.js";
import { FeedbackDeadLetterStore } from "../../../packages/core/src/feedback-process/dead-letter.js";
import { writeAtomicJson } from "../../../packages/core/src/infra/atomic-json.js";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";

const temporaryDirectories: string[] = [];

async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-feedback-outbox-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

function message(idempotencyKey: string): FeedbackMessage {
  return {
    protocolVersion: 1,
    messageId: "3f1c8a52-6d47-4d0e-9a3b-2c5e7f8a1b64",
    source: { sourceType: "agent", agentInstanceId: "agent-a1", agentRole: "secondary" },
    recipientId: "scheduler:mission-1",
    priority: "instruction",
    createdAtIso: "2026-11-21T00:00:00.000Z",
    idempotencyKey,
    payload: { kind: "instruction", instructionText: "请继续" },
  };
}

async function seed(stateDirectory: string, idempotencyKey: string): Promise<string> {
  const fileName = `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`;
  const store = new FeedbackDeadLetterStore({ baseDirectory: stateDirectory });
  await writeAtomicJson(path.join(store.directoryPath, fileName), {
    schemaVersion: 1,
    rejectedAtIso: "2026-11-21T00:00:01.000Z",
    rejectionCode: "invalid-message",
    rejectionReason: "Invalid UUID",
    idempotencyKey,
    messageId: message(idempotencyKey).messageId,
    message: message(idempotencyKey),
  });
  return fileName;
}

describe("feedback-outbox CLI", () => {
  it("① 空清单：明确说明'没有死信'且不伪造条目", async () => {
    const stateDirectory = await createBaseDirectory();
    const chunks = captureStdout();
    const exitCode = await executeFeedbackOutboxListCommand({
      stateDirectory,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(chunks.join("")).toContain("没有死信");
  });

  it("② list --json：只读列出死信，含原因码与补送积压", async () => {
    const stateDirectory = await createBaseDirectory();
    await seed(stateDirectory, "key-1");
    await writeAtomicJson(
      path.join(stateDirectory, "feedback-client-outbox", "pending.json"),
      { any: "message" },
    );
    const chunks = captureStdout();
    const exitCode = await executeFeedbackOutboxListCommand({
      stateDirectory,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(chunks.join("")) as {
      count: number;
      pendingOutboxCount: number;
      entries: Array<{ rejectionCode: string }>;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.pendingOutboxCount).toBe(1);
    expect(parsed.entries[0]?.rejectionCode).toBe("invalid-message");
  });

  it("③ requeue：写回补送并删除死信；未知文件退出码 1；非法名退出码 2", async () => {
    const stateDirectory = await createBaseDirectory();
    const fileName = await seed(stateDirectory, "key-2");

    const requeueExit = await executeFeedbackOutboxRequeueCommand({
      stateDirectory,
      fileName,
      isJsonOutput: false,
    });
    expect(requeueExit).toBe(0);
    const outbox = path.join(
      stateDirectory,
      "feedback-client-outbox",
      fileName,
    );
    await expect(readFile(outbox, "utf8")).resolves.toContain("key-2");

    const missingExit = await executeFeedbackOutboxRequeueCommand({
      stateDirectory,
      fileName,
      isJsonOutput: false,
    });
    expect(missingExit).toBe(1);

    const invalidExit = await executeFeedbackOutboxRequeueCommand({
      stateDirectory,
      fileName: "../../escape.json",
      isJsonOutput: false,
    });
    expect(invalidExit).toBe(2);
  });

  it("④ remove：清除死信；再次清除退出码 1", async () => {
    const stateDirectory = await createBaseDirectory();
    const fileName = await seed(stateDirectory, "key-3");
    const first = await executeFeedbackOutboxRemoveCommand({
      stateDirectory,
      fileName,
      isJsonOutput: true,
    });
    expect(first).toBe(0);
    const second = await executeFeedbackOutboxRemoveCommand({
      stateDirectory,
      fileName,
      isJsonOutput: true,
    });
    expect(second).toBe(1);
  });
});
