/**
 * COMM-01-02 投递通道反例（2026-10-24）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import {
  CollaborationInboxDeliveryService,
  type CollaborationInboxTransportPort,
} from "../../../packages/core/src/orchestration/collaboration-inbox-delivery.js";

const temporaryDirectories: string[] = [];

async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-inbox-delivery-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function seed(store: CollaborationInboxStore, options: { authorizationEpoch?: number } = {}) {
  const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 3 });
  inbox.enqueue({
    messageIdentifier: "m-1",
    correlationIdentifier: "c-1",
    recipientAgentInstanceId: "agent-b",
    senderAgentInstanceId: "agent-a",
    taskIdentifier: "task-1",
    summary: "核对",
    receivedAtIso: "2026-10-24T00:00:00.000Z",
    ...(options.authorizationEpoch === undefined ? {} : { authorizationEpoch: options.authorizationEpoch }),
  });
  await store.save("agent-b", {
    messages: inbox.toSnapshot(),
    expectedRevision: 0,
    updatedAtIso: "2026-10-24T00:00:01.000Z",
  });
}

function createService(store: CollaborationInboxStore, transport: CollaborationInboxTransportPort, maximumDeliveryAttempts = 3) {
  return new CollaborationInboxDeliveryService({
    store,
    transport,
    options: { maximumPendingPerRecipient: 5, maximumDeliveryAttempts },
  });
}

describe("COMM-01-02 投递通道", () => {
  it("① 成功投递落盘；再次投递无事可做且不重复发送", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    await seed(store);
    const send = vi.fn(async () => ({ isDelivered: true }));
    const service = createService(store, { send });

    const report = await service.deliverPendingForRecipient({ recipientAgentInstanceId: "agent-b", nowIso: "2026-10-24T00:00:02.000Z" });
    expect(report.outcome).toBe("delivered");
    expect(report.deliveredCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);

    const persisted = await store.read("agent-b");
    expect(persisted.kind).toBe("valid");
    if (persisted.kind === "valid") expect(persisted.snapshot.messages[0]?.state).toBe("delivered");

    const second = await service.deliverPendingForRecipient({ recipientAgentInstanceId: "agent-b", nowIso: "2026-10-24T00:00:03.000Z" });
    expect(second.outcome).toBe("nothing-pending");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("② 失败 ⇒ 计数与退避落盘，状态仍是 received（可重试）", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    await seed(store);
    const service = createService(store, { send: async () => ({ isDelivered: false, reason: "超时" }) });

    const report = await service.deliverPendingForRecipient({ recipientAgentInstanceId: "agent-b", nowIso: "2026-10-24T00:00:02.000Z" });
    expect(report.retriedCount).toBe(1);
    expect(report.exhaustedCount).toBe(0);

    const persisted = await store.read("agent-b");
    if (persisted.kind !== "valid") throw new Error("应可读");
    expect(persisted.snapshot.messages[0]?.state).toBe("received");
    expect(persisted.snapshot.messages[0]?.deliveryAttemptCount).toBe(1);
  });

  it("③ 重试耗尽 ⇒ 转 failed，之后不再发送", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    await seed(store);
    const send = vi.fn(async () => ({ isDelivered: false, reason: "仍失败" }));
    const service = createService(store, { send }, 1);

    const report = await service.deliverPendingForRecipient({ recipientAgentInstanceId: "agent-b", nowIso: "2026-10-24T00:00:02.000Z" });
    expect(report.exhaustedCount).toBe(1);
    const persisted = await store.read("agent-b");
    if (persisted.kind !== "valid") throw new Error("应可读");
    expect(persisted.snapshot.messages[0]?.state).toBe("failed");

    const second = await service.deliverPendingForRecipient({ recipientAgentInstanceId: "agent-b", nowIso: "2026-10-24T00:00:03.000Z" });
    expect(second.outcome).toBe("nothing-pending");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("④ 授权代已变 ⇒ 跳过且不发送（不落新任务）", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    await seed(store, { authorizationEpoch: 7 });
    const send = vi.fn(async () => ({ isDelivered: true }));
    const service = createService(store, { send });

    const report = await service.deliverPendingForRecipient({
      recipientAgentInstanceId: "agent-b",
      nowIso: "2026-10-24T00:00:02.000Z",
      currentAuthorizationEpoch: 8,
    });
    expect(report.skippedStaleCount).toBe(1);
    expect(report.deliveredCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    const persisted = await store.read("agent-b");
    if (persisted.kind !== "valid") throw new Error("应可读");
    expect(persisted.snapshot.messages[0]?.state).toBe("received");
  });

  it("⑤ 落盘 revision 冲突 ⇒ 报告冲突且不覆盖他人更新", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    await seed(store);
    const service = createService(store, {
      send: async () => {
        await store.save("agent-b", {
          messages: (await store.read("agent-b")).kind === "valid" ? [] : [],
          expectedRevision: 1,
          updatedAtIso: "2026-10-24T00:00:05.000Z",
        });
        return { isDelivered: true };
      },
    });

    const report = await service.deliverPendingForRecipient({ recipientAgentInstanceId: "agent-b", nowIso: "2026-10-24T00:00:06.000Z" });
    expect(report.outcome).toBe("revision-conflict");
    const persisted = await store.read("agent-b");
    if (persisted.kind !== "valid") throw new Error("应可读");
    expect(persisted.snapshot.revision).toBe(2);
    expect(persisted.snapshot.messages).toHaveLength(0);
  });

  it("⑥ 收件箱不存在 ⇒ no-inbox 且不发送", async () => {
    const baseDirectory = await createBaseDirectory();
    const store = new CollaborationInboxStore({ baseDirectory });
    const send = vi.fn(async () => ({ isDelivered: true }));
    const report = await createService(store, { send }).deliverPendingForRecipient({
      recipientAgentInstanceId: "nobody",
      nowIso: "2026-10-24T00:00:02.000Z",
    });
    expect(report.outcome).toBe("no-inbox");
    expect(send).not.toHaveBeenCalled();
  });
});
