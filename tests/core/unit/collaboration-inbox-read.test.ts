/**
 * 用户裁决 A（2026-11-21）：协作收件箱的**只读读取出口**。
 *
 * 钉住四条纪律：
 * 1. 读取不改状态（四态机不动、不记交付失败）；
 * 2. 身份隔离（只返回请求者自己的消息）；
 * 3. 授权过滤（只读复核，未通过不计入结果、只如实计数）；
 * 4. 分页稳定（按 receivedAtIso + messageIdentifier 排序，游标不重复不跳条）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import {
  buildPendingCollaborationView,
  createCollaborationInboxReadPort,
} from "../../../packages/core/src/orchestration/collaboration-inbox-read.js";
import type { CollaborationInboxMessage } from "../../../packages/core/src/orchestration/collaboration-inbox.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "collab-inbox-read-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function message(overrides: Partial<CollaborationInboxMessage> = {}): CollaborationInboxMessage {
  return {
    messageIdentifier: "m-1",
    correlationIdentifier: "c-1",
    recipientAgentInstanceId: "agent-b1",
    senderAgentInstanceId: "agent-a1",
    originalSourceAgentInstanceId: "agent-a1",
    isRelayedRequest: false,
    taskIdentifier: "task-1",
    artifactReferenceStatus: "not-provided",
    summary: "请查询状态",
    receivedAtIso: "2026-11-21T00:00:00.000Z",
    authorizationEpoch: 1,
    authorizationIdentifier: "authorization-1",
    state: "received",
    deliveryAttemptCount: 0,
    lastFailureAtIso: null,
    deliveredAtIso: null,
    processedAtIso: null,
    completedAtIso: null,
    duplicateDeliveryCount: 0,
    ...overrides,
  } as unknown as CollaborationInboxMessage;
}

async function grant(authorizationIdentifier: string): Promise<void> {
  await new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory }).grantAuthorization({
    authorizationIdentifier,
    sourceProjectIdentifier: "project-a",
    sourceProjectRevision: 1,
    targetProjectIdentifier: "project-b",
    targetProjectRevision: 1,
    operationKind: "read",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: `sha256:${"0".repeat(64)}`,
    expiresAtIso: "2026-12-31T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "task-1",
    receivingAgentInstanceId: "agent-b1",
    nowIso: "2026-11-20T00:00:00.000Z",
  });
}

describe("协作收件箱只读视图（纯函数）", () => {
  it("① 只返回请求者自己的 received 消息（身份隔离 + 排除已投递态）", () => {
    const view = buildPendingCollaborationView({
      messages: [
        message({ messageIdentifier: "m-own", receivedAtIso: "2026-11-21T00:00:01.000Z" }),
        message({ messageIdentifier: "m-other", recipientAgentInstanceId: "agent-x" }),
        message({ messageIdentifier: "m-delivered", state: "delivered" }),
        message({ messageIdentifier: "m-failed", state: "failed" }),
      ],
      requestingAgentInstanceId: "agent-b1",
      authorizedMessageIdentifiers: new Set(["m-own", "m-other", "m-delivered", "m-failed"]),
    });
    expect(view.items.map((item) => item.messageIdentifier)).toEqual(["m-own"]);
    expect(view.totalPendingCount).toBe(1);
    expect(view.skippedUnauthorizedCount).toBe(0);
  });

  it("② 未通过授权的消息不出现在结果里，只如实计数", () => {
    const view = buildPendingCollaborationView({
      messages: [
        message({ messageIdentifier: "m-auth" }),
        message({ messageIdentifier: "m-unauthed", receivedAtIso: "2026-11-21T00:00:02.000Z" }),
      ],
      requestingAgentInstanceId: "agent-b1",
      authorizedMessageIdentifiers: new Set(["m-auth"]),
    });
    expect(view.items.map((item) => item.messageIdentifier)).toEqual(["m-auth"]);
    expect(view.skippedUnauthorizedCount).toBe(1);
    expect(view.totalPendingCount).toBe(1);
  });

  it("③ 稳定排序 + 分页游标：不重不漏", () => {
    const messages = [
      message({ messageIdentifier: "m-c", receivedAtIso: "2026-11-21T00:00:03.000Z" }),
      message({ messageIdentifier: "m-a", receivedAtIso: "2026-11-21T00:00:01.000Z" }),
      message({ messageIdentifier: "m-b", receivedAtIso: "2026-11-21T00:00:02.000Z" }),
    ];
    const authorized = new Set(["m-a", "m-b", "m-c"]);
    const first = buildPendingCollaborationView({
      messages,
      requestingAgentInstanceId: "agent-b1",
      authorizedMessageIdentifiers: authorized,
      pageSize: 2,
    });
    expect(first.items.map((item) => item.messageIdentifier)).toEqual(["m-a", "m-b"]);
    expect(first.isTruncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = buildPendingCollaborationView({
      messages,
      requestingAgentInstanceId: "agent-b1",
      authorizedMessageIdentifiers: authorized,
      pageSize: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.messageIdentifier)).toEqual(["m-c"]);
    expect(second.isTruncated).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("④ 投影只含标识/归属/摘要，不含正文或其他载荷字段", () => {
    const view = buildPendingCollaborationView({
      messages: [message()],
      requestingAgentInstanceId: "agent-b1",
      authorizedMessageIdentifiers: new Set(["m-1"]),
    });
    const item = view.items[0] as unknown as Record<string, unknown>;
    expect(item).toMatchObject({ messageIdentifier: "m-1", summary: "请查询状态" });
    expect(item).not.toHaveProperty("payload");
    expect(item).not.toHaveProperty("artifactReferences");
    expect(view.readOnlyNotice).toContain("读取不改变消息状态");
  });

  it("⑤ 页大小与游标参数被规范化（0/负数 ⇒ 至少 1；超过上限 ⇒ 50）", () => {
    const messages = Array.from({ length: 60 }, (_unused, index) =>
      message({
        messageIdentifier: `m-${String(index).padStart(2, "0")}`,
        receivedAtIso: `2026-11-21T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      }),
    );
    const authorized = new Set(messages.map((item) => item.messageIdentifier));
    const tooLarge = buildPendingCollaborationView({
      messages,
      requestingAgentInstanceId: "agent-b1",
      authorizedMessageIdentifiers: authorized,
      pageSize: 500,
    });
    expect(tooLarge.items).toHaveLength(50);
    const tooSmall = buildPendingCollaborationView({
      messages,
      requestingAgentInstanceId: "agent-b1",
      authorizedMessageIdentifiers: authorized,
      pageSize: 0,
    });
    expect(tooSmall.items).toHaveLength(1);
  });
});

describe("协作收件箱只读端口（真实存储）", () => {
  it("⑥ 有章且当前代 ⇒ 可见；无章 ⇒ 跳过计数；读取两次不改变消息状态", async () => {
    await grant("authorization-1");
    const inbox = new CollaborationInbox({
      maximumPendingPerRecipient: 5,
      maximumDeliveryAttempts: 3,
    } as never);
    inbox.enqueue({
      messageIdentifier: "message-auth",
      correlationIdentifier: "corr-1",
      recipientAgentInstanceId: "agent-b1",
      senderAgentInstanceId: "agent-a1",
      taskIdentifier: "task-1",
      summary: "有章请求",
      receivedAtIso: "2026-11-21T00:00:01.000Z",
      authorizationIdentifier: "authorization-1",
      authorizationEpoch: 1,
    } as never);
    inbox.enqueue({
      messageIdentifier: "message-noauth",
      correlationIdentifier: "corr-2",
      recipientAgentInstanceId: "agent-b1",
      senderAgentInstanceId: "agent-a1",
      taskIdentifier: "task-1",
      summary: "无章请求",
      receivedAtIso: "2026-11-21T00:00:02.000Z",
    } as never);

    const inboxStore = new CollaborationInboxStore({ baseDirectory: stateDirectory });
    await inboxStore.save("agent-b1", {
      messages: inbox.toSnapshot(),
      expectedRevision: 0,
      updatedAtIso: "2026-11-21T00:00:03.000Z",
    });

    const port = createCollaborationInboxReadPort({
      inboxStore,
      authorizationStore: new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory }),
    });

    const first = await port.readPendingCollaboration({
      requestingAgentInstanceId: "agent-b1",
    });
    expect(first.isAvailable).toBe(true);
    if (!first.isAvailable) {
      return;
    }
    expect(first.items.map((item) => item.messageIdentifier)).toEqual(["message-auth"]);
    expect(first.skippedUnauthorizedCount).toBe(1);

    const persisted = await inboxStore.read("agent-b1");
    if (persisted.kind !== "valid") {
      throw new Error("应可读");
    }
    const authMessage = persisted.snapshot.messages.find(
      (item) => item.messageIdentifier === "message-auth",
    );
    expect(authMessage?.state).toBe("received");
    expect(authMessage?.deliveryAttemptCount).toBe(0);

    const second = await port.readPendingCollaboration({
      requestingAgentInstanceId: "agent-b1",
    });
    expect(second.isAvailable).toBe(true);
    if (!second.isAvailable) {
      return;
    }
    expect(second.items).toHaveLength(1);
  });

  it("⑦ 收件箱损坏 ⇒ 明确不可用（不伪装成没有消息）", async () => {
    const port = createCollaborationInboxReadPort({
      inboxStore: {
        read: async () => ({ kind: "invalid", reason: "schema 不符" }),
      },
      authorizationStore: new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory }),
    });
    const outcome = await port.readPendingCollaboration({
      requestingAgentInstanceId: "agent-b1",
    });
    expect(outcome.isAvailable).toBe(false);
    if (outcome.isAvailable) {
      return;
    }
    expect(outcome.reason).toContain("损坏");
  });
});
