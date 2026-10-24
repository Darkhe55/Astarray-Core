/**
 * COMM-01-02 收件箱持久化反例（2026-10-24）。
 *
 * 目的：内存状态机必须能落盘并在重启后恢复；损坏文件不得被静默覆盖；
 * 并发写用 revision 乐观锁拒绝陈旧写入。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import {
  CollaborationInboxStore,
} from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";

const temporaryDirectories: string[] = [];

async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-inbox-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function inboxWithMessage() {
  const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 3 });
  inbox.enqueue({
    messageIdentifier: "message-1",
    correlationIdentifier: "corr-1",
    recipientAgentInstanceId: "agent-b",
    senderAgentInstanceId: "agent-a",
    taskIdentifier: "task-1",
    summary: "核对日志",
    receivedAtIso: "2026-10-24T00:00:00.000Z",
  });
  return inbox;
}

describe("COMM-01-02 收件箱持久化", () => {
  it("① 保存后重启可恢复（状态不丢，received 仍是 received）", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    const inbox = inboxWithMessage();
    const saved = await store.save("agent-b", {
      messages: inbox.listForRecipient("agent-b"),
      expectedRevision: 0,
      updatedAtIso: "2026-10-24T00:00:01.000Z",
    });
    expect(saved.revision).toBe(1);

    const reopenedStore = new CollaborationInboxStore({ baseDirectory });
    const readOutcome = await reopenedStore.read("agent-b");
    expect(readOutcome.kind).toBe("valid");
    if (readOutcome.kind !== "valid") return;
    const restored = CollaborationInbox.fromSnapshot({
      messages: readOutcome.snapshot.messages,
      maximumPendingPerRecipient: 5,
      maximumDeliveryAttempts: 3,
    });
    expect(restored.getMessage("message-1")?.state).toBe("received");
    expect(restored.listForRecipient("agent-b")).toHaveLength(1);
  });

  it("② 陈旧 revision 的写入被拒（不覆盖他人更新）", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    const inbox = inboxWithMessage();
    await store.save("agent-b", { messages: inbox.listForRecipient("agent-b"), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:01.000Z" });
    await expect(
      store.save("agent-b", { messages: inbox.listForRecipient("agent-b"), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:02.000Z" }),
    ).rejects.toThrow(/revision/i);
  });

  it("③ 未保存过的收件人 ⇒ absent（不伪造空收件箱）", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    expect((await store.read("nobody")).kind).toBe("absent");
  });

  it("④ 损坏文件 ⇒ invalid 且**不覆盖**（内容保持原样）", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    const filePath = store.pathFor("agent-b");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{ not json", "utf8");
    const before = await readFile(filePath, "utf8");

    const outcome = await store.read("agent-b");
    expect(outcome.kind).toBe("invalid");
    await expect(
      store.save("agent-b", { messages: [], expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:01.000Z" }),
    ).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("⑤ 版本/字段不合法 ⇒ invalid 并给原因", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    const filePath = store.pathFor("agent-b");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, recipientAgentInstanceId: "agent-b", messages: [] }), "utf8");
    const outcome = await store.read("agent-b");
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(outcome.reason).toContain("schemaVersion");
  });
});

