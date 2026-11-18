/**
 * COORD-02 §7 反例：投递通道**逐条按权威授权复核**（2026-11-19）。
 *
 * 装配路径：收件箱待投递 → 权威复核端口 → 通过才 `send` 并标 delivered；
 * 被拒 ⇒ 不发送、不确认已消费、保留 pending（计数可诊断）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { CollaborationInboxDeliveryService } from "../../../packages/core/src/orchestration/collaboration-inbox-delivery.js";

const temporaryDirectories: string[] = [];

async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "authoritative-assembly-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10 })),
  );
});

async function seed(
  store: CollaborationInboxStore,
  messages: ReadonlyArray<{
    messageIdentifier: string;
    authorizationEpoch: number;
    authorizationIdentifier: string | null;
  }>,
): Promise<void> {
  const inbox = new CollaborationInbox({
    maximumPendingPerRecipient: 10,
    maximumDeliveryAttempts: 3,
  } as never);
  for (const message of messages) {
    inbox.enqueue({
      messageIdentifier: message.messageIdentifier,
      correlationIdentifier: `correlation-${message.messageIdentifier}`,
      recipientAgentInstanceId: "agent-b",
      senderAgentInstanceId: "agent-a",
      taskIdentifier: "task-1",
      summary: "核对",
      receivedAtIso: "2026-11-19T00:00:00.000Z",
      authorizationEpoch: message.authorizationEpoch,
      authorizationIdentifier: message.authorizationIdentifier,
    } as never);
  }
  await store.save("agent-b", {
    messages: inbox.toSnapshot(),
    expectedRevision: 0,
    updatedAtIso: "2026-11-19T00:00:01.000Z",
  });
}

describe("COORD-02 §7：投递通道的权威复核", () => {
  it("① 被拒消息不发送、不确认已消费；通过的消息正常投递", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory } as never);
    await seed(store, [
      {
        messageIdentifier: "m-ok",
        authorizationEpoch: 2,
        authorizationIdentifier: "authorization-ok",
      },
      {
        messageIdentifier: "m-revoked",
        authorizationEpoch: 2,
        authorizationIdentifier: "authorization-revoked",
      },
      {
        messageIdentifier: "m-stale",
        authorizationEpoch: 1,
        authorizationIdentifier: "authorization-ok",
      },
    ]);

    const send = vi.fn(async () => ({ isDelivered: true }));
    const service = new CollaborationInboxDeliveryService({
      store,
      transport: { send },
      options: {
        maximumPendingPerRecipient: 10,
        maximumDeliveryAttempts: 3,
        resolveAuthoritativeAuthorizationEpoch: async (message) => {
          if (message.authorizationIdentifier === "authorization-revoked") {
            return { kind: "rejected", code: "authorization-revoked", detail: "已撤销" };
          }
          if (message.authorizationIdentifier === null) {
            return { kind: "rejected", code: "authorization-missing", detail: "缺章" };
          }
          return { kind: "authorized", epoch: 2 };
        },
      },
    });

    const report = await service.deliverPendingForRecipient({
      recipientAgentInstanceId: "agent-b",
      nowIso: "2026-11-19T00:00:02.000Z",
    });

    expect(report.deliveredCount).toBe(1);
    expect(report.skippedUnauthorizedCount).toBe(1);
    expect(report.skippedStaleCount).toBe(1);
    /** 只有通过复核的那条被真正发送。 */
    expect(send).toHaveBeenCalledTimes(1);
    const calls = send.mock.calls as unknown as Array<[{ messageIdentifier: string }]>;
    expect(calls[0]?.[0].messageIdentifier).toBe("m-ok");

    const persisted = await store.read("agent-b");
    if (persisted.kind !== "valid") {
      throw new Error("收件箱应可读");
    }
    const states = new Map(
      persisted.snapshot.messages.map((message) => [message.messageIdentifier, message.state]),
    );
    expect(states.get("m-ok")).toBe("delivered");
    /** 被拒与陈旧的消息仍是 pending（不确认已消费）。 */
    expect(states.get("m-revoked")).toBe("received");
    expect(states.get("m-stale")).toBe("received");
  }, 60_000);
});
