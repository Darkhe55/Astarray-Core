/**
 * COMM-01-02：本地 outbox 适配器 + 反馈协议映射 + `inbox deliver` CLI（2026-10-24）。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { CollaborationOutboxTransport } from "../../../packages/core/src/orchestration/collaboration-outbox-transport.js";
import { CollaborationFeedbackTransport } from "../../../packages/core/src/orchestration/collaboration-feedback-transport.js";
import {
  buildCollaborationFeedbackMessage,
  fromCollaborationRecipientId,
  toCollaborationRecipientId,
} from "../../../packages/core/src/orchestration/collaboration-feedback-mapping.js";
import { executeInboxDeliverCommand } from "../../../packages/tui/src/cli/inbox-command.js";

const temporaryDirectories: string[] = [];
async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-outbox-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sampleMessage(overrides: Record<string, unknown> = {}) {
  const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 3 });
  inbox.enqueue({
    messageIdentifier: "m-1",
    correlationIdentifier: "c-1",
    recipientAgentInstanceId: "agent-b",
    senderAgentInstanceId: "agent-a",
    taskIdentifier: "task-1",
    summary: "核对",
    receivedAtIso: "2026-10-24T00:00:00.000Z",
    ...overrides,
  });
  return inbox.getMessage("m-1")!;
}

describe("本地 outbox 适配器", () => {
  it("① 写入队列文件（含必要字段），重复发送不产生第二份", async () => {
    const baseDirectory = await createBaseDirectory();
    const transport = new CollaborationOutboxTransport({ baseDirectory });
    const message = sampleMessage();
    expect((await transport.send(message)).isDelivered).toBe(true);
    const filePath = transport.pathFor("agent-b", "m-1");
    const firstContent = await readFile(filePath, "utf8");
    const parsed = JSON.parse(firstContent);
    expect(parsed.messageIdentifier).toBe("m-1");
    expect(parsed.recipientAgentInstanceId).toBe("agent-b");
    expect(parsed.authorizationEpoch).toBe(0);

    expect((await transport.send(message)).isDelivered).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe(firstContent);
  });
});

describe("反馈协议映射（用户批准的扩展 a + 前缀 b）", () => {
  it("② 收件人前缀为 agent:，payload 为 collaboration-request", () => {
    expect(toCollaborationRecipientId("agent-b")).toBe("agent:agent-b");
    expect(fromCollaborationRecipientId("agent:agent-b")).toBe("agent-b");
    expect(fromCollaborationRecipientId("other:agent-b")).toBeNull();

    const feedback = buildCollaborationFeedbackMessage({
      message: sampleMessage(),
      sourceAgentRole: "secondary",
    });
    expect(feedback.recipientId).toBe("agent:agent-b");
    expect(feedback.payload.kind).toBe("collaboration-request");
    expect(feedback.priority).toBe("instruction");
    expect(feedback.idempotencyKey).toBe("m-1");
    if (feedback.payload.kind === "collaboration-request") {
      expect(feedback.payload.taskIdentifier).toBe("task-1");
    }
  });

  it("③ 反馈进程可用 ⇒ 已入队（明确不等于已处理）；不可用 ⇒ 不标投递", async () => {
    const enqueued: unknown[] = [];
    const transport = new CollaborationFeedbackTransport({
      feedbackTransport: {
        enqueue: async (message) => {
          enqueued.push(message);
        },
        queryHealth: async () => ({ isHealthy: true, processPid: 1, protocolVersion: 1, queuedMessageCount: 0 }),
        shutdown: async () => undefined,
        setAgentStatus: () => undefined,
        onMessage: () => undefined,
      },
      sourceAgentRole: "secondary",
    });
    const delivered = await transport.send(sampleMessage());
    expect(delivered.isDelivered).toBe(true);
    expect(delivered.reason).toContain("入队");
    expect(enqueued).toHaveLength(1);

    const broken = new CollaborationFeedbackTransport({
      feedbackTransport: {
        enqueue: async () => {
          throw new Error("进程未启动");
        },
        queryHealth: async () => ({ isHealthy: false, processPid: null, protocolVersion: 1, queuedMessageCount: 0 }),
        shutdown: async () => undefined,
        setAgentStatus: () => undefined,
        onMessage: () => undefined,
      },
      sourceAgentRole: "secondary",
    });
    const failed = await broken.send(sampleMessage());
    expect(failed.isDelivered).toBe(false);
    expect(failed.reason).toContain("反馈进程不可用");
  });
});

describe("inbox deliver CLI", () => {
  it("④ 投递后 outbox 出现文件，JSON 报告 delivered", async () => {
    const stateDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory: stateDirectory });
    const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 3 });
    inbox.enqueue({
      messageIdentifier: "m-1",
      correlationIdentifier: "c-1",
      recipientAgentInstanceId: "agent-b",
      senderAgentInstanceId: "agent-a",
      taskIdentifier: "task-1",
      summary: "核对",
      receivedAtIso: "2026-10-24T00:00:00.000Z",
    });
    await store.save("agent-b", { messages: inbox.toSnapshot(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:01.000Z" });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeInboxDeliverCommand({
      stateDirectory,
      recipientAgentInstanceId: "agent-b",
      transportName: "file-outbox",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.report.outcome).toBe("delivered");
    const outbox = new CollaborationOutboxTransport({ baseDirectory: stateDirectory });
    const filePath = outbox.pathFor("agent-b", "m-1");
    expect(JSON.parse(await readFile(filePath, "utf8")).messageIdentifier).toBe("m-1");
  });

  it("⑤ 收件箱不存在 ⇒ 退出码 2（不伪造投递）", async () => {
    const stateDirectory = await createBaseDirectory();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitCode = await executeInboxDeliverCommand({
      stateDirectory,
      recipientAgentInstanceId: "nobody",
      transportName: "file-outbox",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(2);
  });
});
