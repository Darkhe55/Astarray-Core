/**
 * COMM-01-02 `inbox list` 只读 CLI 反例（2026-10-24）。
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeInboxListCommand } from "../../../packages/tui/src/cli/inbox-command.js";
import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";

const temporaryDirectories: string[] = [];

async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-inbox-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("COMM-01-02 inbox list", () => {
  it("① 已保存收件箱 ⇒ JSON 输出含 revision 与消息", async () => {
    const stateDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory: stateDirectory });
    const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 2 });
    inbox.enqueue({
      messageIdentifier: "m-1",
      correlationIdentifier: "c-1",
      recipientAgentInstanceId: "agent-b",
      senderAgentInstanceId: "agent-a",
      taskIdentifier: "task-1",
      summary: "核对",
      receivedAtIso: "2026-10-24T00:00:00.000Z",
    });
    inbox.markDelivered("m-1", "2026-10-24T00:00:01.000Z");
    await store.save("agent-b", { messages: inbox.toSnapshot(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:02.000Z" });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeInboxListCommand({
      stateDirectory,
      recipientAgentInstanceId: "agent-b",
      stateFilter: null,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.isPresent).toBe(true);
    expect(payload.revision).toBe(1);
    expect(payload.messages[0].state).toBe("delivered");
  });

  it("② 未保存过 ⇒ 明确「空 ≠ 无消息」，退出码 0", async () => {
    const stateDirectory = await createBaseDirectory();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeInboxListCommand({
      stateDirectory,
      recipientAgentInstanceId: "nobody",
      stateFilter: null,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.isPresent).toBe(false);
    expect(payload.notice).toContain("空 ≠ 无消息");
  });

  it("③ 损坏文件 ⇒ 退出码 2 且不静默当空", async () => {
    const stateDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory: stateDirectory });
    const filePath = store.pathFor("agent-b");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{oops", "utf8");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    });
    const exitCode = await executeInboxListCommand({
      stateDirectory,
      recipientAgentInstanceId: "agent-b",
      stateFilter: null,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(2);
    expect(errors.join("")).toContain("不可读");
  });

  it("④ 状态过滤生效（只显示 completed）", async () => {
    const stateDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory: stateDirectory });
    const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 2 });
    for (const [identifier, state] of [
      ["m-1", "delivered"],
      ["m-2", "completed"],
    ] as const) {
      inbox.enqueue({
        messageIdentifier: identifier,
        correlationIdentifier: "c-" + identifier,
        recipientAgentInstanceId: "agent-b",
        senderAgentInstanceId: "agent-a",
        taskIdentifier: "task-1",
        summary: "x",
        receivedAtIso: "2026-10-24T00:00:00.000Z",
      });
      if (state === "delivered") {
        inbox.markDelivered(identifier, "2026-10-24T00:00:01.000Z");
      } else {
        inbox.markDelivered(identifier, "2026-10-24T00:00:01.000Z");
        inbox.markProcessed(identifier, "2026-10-24T00:00:02.000Z");
        inbox.markCompleted(identifier, "2026-10-24T00:00:03.000Z");
      }
    }
    await store.save("agent-b", { messages: inbox.toSnapshot(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:04.000Z" });
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeInboxListCommand({
      stateDirectory,
      recipientAgentInstanceId: "agent-b",
      stateFilter: "completed",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].messageIdentifier).toBe("m-2");
  });
});
