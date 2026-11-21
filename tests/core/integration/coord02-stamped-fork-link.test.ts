/**
 * COORD-02 §7（2026-11-21）：**盖章 → 反馈映射 → 真实 fork 进程**的完整时序。
 *
 * 此前这条链路实际是断的，而且是"绿的断"：
 * 1. 映射产出 `messageId = "collaboration:<id>"`，`feedbackMessageSchema` 要求 UUID ⇒ 子进程 safeParse 拒绝；
 * 2. `PRIORITY_OF_KIND` 缺 `collaboration-request` ⇒ 任何优先级都被判不一致；
 * 3. 子进程回 `accepted:false`，客户端却当成功并删除补送文件 ⇒ 消息静默丢失，用例仍然全绿。
 *
 * 三条都已修（见同轮提交）。本用例跑通**整链**：SDK 盖章入口入箱 → 落盘 → 交付服务 →
 * `CollaborationFeedbackTransport` → 真实反馈进程 → 投递回接收侧，并核对章（关系标识 + 代际）原样到达。
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
import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import { FeedbackProcessSupervisor } from "../../../packages/core/src/feedback-process/process-supervisor.js";
import { enqueueWithAuthoritativeStamp } from "../../../packages/core/src/public-sdk.js";
import type { FeedbackMessage } from "../../../packages/core/src/core/types.js";

const distEntryPath = path.join(process.cwd(), "dist", "feedback-process-entry.js");
const hasBuiltEntry = existsSync(distEntryPath);

const nowIso = "2026-11-21T00:00:00.000Z";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const temporaryDirectories: string[] = [];
const supervisors: FeedbackProcessSupervisor[] = [];

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.stop().catch(() => undefined)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function waitFor(check: () => boolean, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!hasBuiltEntry)("COORD-02：盖章后经真实反馈进程投递", () => {
  it("盖好的协作消息经 fork 进程投递，接收侧收到同一关系标识与代际", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-coord02-fork-"));
    temporaryDirectories.push(baseDirectory);

    const authorizationStore = new CrossProjectAuthorizationStore({ baseDirectory });
    await authorizationStore.grantAuthorization({
      authorizationIdentifier: "authorization-1",
      sourceProjectIdentifier: "project-a",
      sourceProjectRevision: 1,
      targetProjectIdentifier: "project-b",
      targetProjectRevision: 1,
      operationKind: "read",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: `sha256:${"0".repeat(64)}`,
      expiresAtIso: "2026-12-31T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-001",
      receivingAgentInstanceId: "agent-b1",
      nowIso: "2026-11-20T00:00:00.000Z",
    });

    const inbox = new CollaborationInbox({
      maximumPendingPerRecipient: 5,
      maximumDeliveryAttempts: 3,
    } as never);
    const stamp = await enqueueWithAuthoritativeStamp({
      authorizationStore,
      inbox,
      authorizationIdentifier: "authorization-1",
      nowIso,
      enqueueInput: {
        messageIdentifier: "message-1",
        correlationIdentifier: "correlation-1",
        recipientAgentInstanceId: "agent-b1",
        senderAgentInstanceId: "agent-a1",
        taskIdentifier: "T-001",
        summary: "只读查询",
        receivedAtIso: nowIso,
      },
    });
    expect(stamp.kind).toBe("enqueued");

    const store = new CollaborationInboxStore({ baseDirectory });
    await store.save("agent-b1", {
      messages: inbox.toSnapshot(),
      expectedRevision: 0,
      updatedAtIso: nowIso,
    });

    const supervisor = new FeedbackProcessSupervisor({
      baseDirectory,
      heartbeatTimeoutMilliseconds: 5_000,
      healthCheckIntervalMilliseconds: 1_000,
    });
    supervisors.push(supervisor);
    const client = await supervisor.start();
    /** 子进程按 `setAgentStatus` 登记来源（否则拒绝未注册来源，防伪造）。 */
    client.setAgentStatus("agent-a1", "idle");
    const delivered: FeedbackMessage[] = [];
    client.onMessage((message) => {
      delivered.push(message);
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
      recipientAgentInstanceId: "agent-b1",
      nowIso,
    });
    expect(report.deliveredCount).toBe(1);

    await waitFor(() => delivered.length > 0);
    expect(delivered).toHaveLength(1);
    const message = delivered[0] as FeedbackMessage;
    expect(message.messageId).toMatch(UUID_PATTERN);
    expect(message.priority).toBe("instruction");
    expect(message.authorizationIdentifier).toBe("authorization-1");
    expect(message.payload).toMatchObject({
      kind: "collaboration-request",
      messageIdentifier: "message-1",
      authorizationEpoch: 1,
    });
  });
});
