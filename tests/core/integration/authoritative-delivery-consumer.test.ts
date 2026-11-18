/**
 * COORD-02 §7 反例：消费侧按**权威授权代际**复核（2026-11-19）。
 *
 * 断言：只有权威存储里的当前代与消息一致才投递；缺章/0/查不到/已撤销/旧代
 * 一律**不投递、不确认已消费**，并保留可诊断原因。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import { deliverWithAuthoritativeAuthorization } from "../../../packages/core/src/orchestration/collaboration-authoritative-delivery.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "authoritative-delivery-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

const deliveredAtIso = "2026-11-19T00:00:00.000Z";

function buildStore(): CrossProjectAuthorizationStore {
  return new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory });
}

function buildInbox(): CollaborationInbox {
  return new CollaborationInbox({ stateBaseDirectory: stateDirectory } as never);
}

async function grantAuthorization(authorizationIdentifier: string): Promise<number> {
  const store = buildStore();
  const result = await store.grantAuthorization({
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
    taskIdentifier: "T-001",
    receivingAgentInstanceId: "agent-b1",
    nowIso: "2026-11-18T00:00:00.000Z",
  });
  return result.record?.authorizationEpoch ?? 0;
}

function enqueueMessage(
  inbox: CollaborationInbox,
  input: {
    messageIdentifier: string;
    authorizationEpoch: number;
    authorizationIdentifier: string | null;
  },
): void {
  inbox.enqueue({
    messageIdentifier: input.messageIdentifier,
    correlationIdentifier: `correlation-${input.messageIdentifier}`,
    recipientAgentInstanceId: "agent-b1",
    senderAgentInstanceId: "agent-a1",
    taskIdentifier: "T-001",
    summary: "只读查询",
    receivedAtIso: "2026-11-18T00:00:00.000Z",
    authorizationEpoch: input.authorizationEpoch,
    authorizationIdentifier: input.authorizationIdentifier,
  } as never);
}

describe("COORD-02 §7：消费侧权威复核", () => {
  it("① 当前代一致 ⇒ 投递成功", async () => {
    const epoch = await grantAuthorization("authorization-1");
    expect(epoch).toBe(1);
    const inbox = buildInbox();
    enqueueMessage(inbox, {
      messageIdentifier: "message-1",
      authorizationEpoch: 1,
      authorizationIdentifier: "authorization-1",
    });

    const outcome = await deliverWithAuthoritativeAuthorization({
      authorizationStore: buildStore(),
      inbox,
      messageIdentifier: "message-1",
      deliveredAtIso,
    });
    expect(outcome.isDelivered).toBe(true);
  }, 30_000);

  it("② 缺关系标识 ⇒ 拒绝投递且保留 pending（不确认已消费）", async () => {
    await grantAuthorization("authorization-1");
    const inbox = buildInbox();
    enqueueMessage(inbox, {
      messageIdentifier: "message-1",
      authorizationEpoch: 1,
      authorizationIdentifier: null,
    });

    const outcome = await deliverWithAuthoritativeAuthorization({
      authorizationStore: buildStore(),
      inbox,
      messageIdentifier: "message-1",
      deliveredAtIso,
    });
    expect(outcome).toMatchObject({
      isDelivered: false,
      rejectionCode: "authorization-missing",
    });
    expect(inbox.getMessage("message-1")?.state).toBe("received");
  }, 30_000);

  it("③ 权威存储查不到关系 ⇒ 拒绝投递", async () => {
    const inbox = buildInbox();
    enqueueMessage(inbox, {
      messageIdentifier: "message-1",
      authorizationEpoch: 1,
      authorizationIdentifier: "authorization-unknown",
    });
    const outcome = await deliverWithAuthoritativeAuthorization({
      authorizationStore: buildStore(),
      inbox,
      messageIdentifier: "message-1",
      deliveredAtIso,
    });
    expect(outcome.isDelivered).toBe(false);
    expect((outcome as { rejectionCode: string }).rejectionCode).toBe("authorization-missing");
  }, 30_000);

  it("④ 已撤销 ⇒ 拒绝投递；重新授权后旧代消息仍是旧代", async () => {
    await grantAuthorization("authorization-1");
    const inbox = buildInbox();
    enqueueMessage(inbox, {
      messageIdentifier: "message-1",
      authorizationEpoch: 1,
      authorizationIdentifier: "authorization-1",
    });

    await buildStore().revokeAuthorization("authorization-1", "用户撤权");
    const revokedOutcome = await deliverWithAuthoritativeAuthorization({
      authorizationStore: buildStore(),
      inbox,
      messageIdentifier: "message-1",
      deliveredAtIso,
    });
    expect((revokedOutcome as { rejectionCode: string }).rejectionCode).toBe(
      "authorization-revoked",
    );

    /** 同一关系重新授权 ⇒ 代际升到 3。 */
    const reGrantedEpoch = await grantAuthorization("authorization-2");
    expect(reGrantedEpoch).toBe(3);

    /** 引用**新关系**但带**旧代 1** 的消息：必须按旧章拒绝。 */
    enqueueMessage(inbox, {
      messageIdentifier: "message-2",
      authorizationEpoch: 1,
      authorizationIdentifier: "authorization-2",
    });
    const staleOutcome = await deliverWithAuthoritativeAuthorization({
      authorizationStore: buildStore(),
      inbox,
      messageIdentifier: "message-2",
      deliveredAtIso,
    });
    expect((staleOutcome as { rejectionCode: string }).rejectionCode).toBe(
      "authorization-epoch-stale",
    );
    expect(inbox.getMessage("message-2")?.state).toBe("received");
    expect(inbox.getMessage("message-1")?.state).toBe("received");
  }, 30_000);

  it("⑤ 入箱代为 0（缺章）⇒ 即使权威代也是 1 也不放行", async () => {
    await grantAuthorization("authorization-1");
    const inbox = buildInbox();
    enqueueMessage(inbox, {
      messageIdentifier: "message-1",
      authorizationEpoch: 0,
      authorizationIdentifier: "authorization-1",
    });
    const outcome = await deliverWithAuthoritativeAuthorization({
      authorizationStore: buildStore(),
      inbox,
      messageIdentifier: "message-1",
      deliveredAtIso,
    });
    expect((outcome as { rejectionCode: string }).rejectionCode).toBe(
      "authorization-epoch-absent",
    );
  }, 30_000);
});
