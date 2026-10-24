/**
 * COMM-01-02（2026-10-24）：收件箱 ↔ **真实独立反馈进程**接线集成测试。
 *
 * 目的（用户批准协议扩展后的最后一块）：
 * 1. 真实 fork 子进程可用时，协作消息能入队，收件箱标 `delivered` 并落盘；
 * 2. 反馈进程**不可用**时，投递失败 ⇒ 不标 delivered，保持可重试状态。
 *
 * 需要先 `npm run build`（与既有 T04 集成测试同一前提）。
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { CollaborationInboxDeliveryService } from "../../../packages/core/src/orchestration/collaboration-inbox-delivery.js";
import { CollaborationFeedbackTransport } from "../../../packages/core/src/orchestration/collaboration-feedback-transport.js";
import { FeedbackProcessSupervisor } from "../../../packages/core/src/feedback-process/process-supervisor.js";

const distEntryPath = path.join(process.cwd(), "dist", "feedback-process-entry.js");
const hasBuiltEntry = existsSync(distEntryPath);

const temporaryDirectories: string[] = [];
const supervisors: FeedbackProcessSupervisor[] = [];

async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-inbox-feedback-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.stop().catch(() => undefined)),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function createMessage(overrides: Record<string, unknown> = {}) {
  const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 3 });
  inbox.enqueue({
    messageIdentifier: "m-1",
    correlationIdentifier: "c-1",
    recipientAgentInstanceId: "agent-b",
    senderAgentInstanceId: "agent-a",
    taskIdentifier: "task-1",
    summary: "核对构建日志",
    receivedAtIso: "2026-10-24T00:00:00.000Z",
    ...overrides,
  });
  return inbox;
}

describe.skipIf(!hasBuiltEntry)("COMM-01-02 收件箱 ↔ 独立反馈进程", () => {
  it("① 真实进程可用 ⇒ 入队成功、收件箱标 delivered 并落盘", async () => {
    const baseDirectory = await createBaseDirectory();
    const supervisor = new FeedbackProcessSupervisor({
      baseDirectory,
      heartbeatTimeoutMilliseconds: 5_000,
      healthCheckIntervalMilliseconds: 1_000,
    });
    supervisors.push(supervisor);
    const client = await supervisor.start();

    const store = new CollaborationInboxStore({ baseDirectory });
    const inbox = createMessage();
    await store.save("agent-b", {
      messages: inbox.toSnapshot(),
      expectedRevision: 0,
      updatedAtIso: "2026-10-24T00:00:01.000Z",
    });

    const delivery = new CollaborationInboxDeliveryService({
      store,
      transport: new CollaborationFeedbackTransport({
        feedbackTransport: client,
        sourceAgentRole: "secondary",
      }),
      options: { maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 3 },
    });
    const report = await delivery.deliverPendingForRecipient({
      recipientAgentInstanceId: "agent-b",
      nowIso: "2026-10-24T00:00:02.000Z",
    });
    expect(report.deliveredCount).toBe(1);

    const persisted = await store.read("agent-b");
    if (persisted.kind !== "valid") throw new Error("应可读");
    expect(persisted.snapshot.messages[0]?.state).toBe("delivered");
  });

  it("② 反馈进程已停止 ⇒ 投递失败、不标 delivered、保持可重试", async () => {
    const baseDirectory = await createBaseDirectory();
    const supervisor = new FeedbackProcessSupervisor({
      baseDirectory,
      heartbeatTimeoutMilliseconds: 5_000,
      healthCheckIntervalMilliseconds: 1_000,
    });
    supervisors.push(supervisor);
    const client = await supervisor.start();

    const store = new CollaborationInboxStore({ baseDirectory });
    const inbox = createMessage();
    await store.save("agent-b", {
      messages: inbox.toSnapshot(),
      expectedRevision: 0,
      updatedAtIso: "2026-10-24T00:00:01.000Z",
    });

    await supervisor.stop();

    const delivery = new CollaborationInboxDeliveryService({
      store,
      transport: new CollaborationFeedbackTransport({
        feedbackTransport: client,
        sourceAgentRole: "secondary",
      }),
      options: { maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 3 },
    });
    const report = await delivery.deliverPendingForRecipient({
      recipientAgentInstanceId: "agent-b",
      nowIso: "2026-10-24T00:00:02.000Z",
    });
    expect(report.deliveredCount).toBe(0);
    expect(report.retriedCount + report.exhaustedCount).toBe(1);

    const persisted = await store.read("agent-b");
    if (persisted.kind !== "valid") throw new Error("应可读");
    expect(persisted.snapshot.messages[0]?.state).toBe("received");
    expect(persisted.snapshot.messages[0]?.deliveryAttemptCount).toBe(1);
  });
});
