/**
 * COORD-02 §7 反例：生产侧盖章（2026-11-19）。
 *
 * 盖章只能来自权威存储：调用方伪造的代际/关系标识必须被忽略；
 * 已撤销/已过期/查不到 ⇒ 拒绝入箱（不给"先入箱再验"的机会）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import {
  enqueueWithAuthoritativeStamp,
  resolveAuthorizationStamp,
} from "../../../packages/core/src/orchestration/collaboration-authorization-stamping.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-stamping-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

const nowIso = "2026-11-19T00:00:00.000Z";

function buildStore(): CrossProjectAuthorizationStore {
  return new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory });
}

function buildInbox(): CollaborationInbox {
  return new CollaborationInbox({
    maximumPendingPerRecipient: 5,
    maximumDeliveryAttempts: 3,
  } as never);
}

async function grant(
  authorizationIdentifier: string,
  options: { expiresAtIso?: string } = {},
): Promise<void> {
  await buildStore().grantAuthorization({
    authorizationIdentifier,
    sourceProjectIdentifier: "project-a",
    sourceProjectRevision: 1,
    targetProjectIdentifier: "project-b",
    targetProjectRevision: 1,
    operationKind: "read",
    resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: `sha256:${"0".repeat(64)}`,
    expiresAtIso: options.expiresAtIso ?? "2026-12-31T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-001",
    receivingAgentInstanceId: "agent-b1",
    nowIso: "2026-11-18T00:00:00.000Z",
  });
}

function baseEnqueueInput(overrides: Record<string, unknown> = {}) {
  return {
    messageIdentifier: "message-1",
    correlationIdentifier: "correlation-1",
    recipientAgentInstanceId: "agent-b1",
    senderAgentInstanceId: "agent-a1",
    taskIdentifier: "T-001",
    summary: "只读查询",
    receivedAtIso: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("COORD-02 §7：生产侧盖章", () => {
  it("① 调用方伪造代际 99 ⇒ 入箱章仍是权威代 1", async () => {
    await grant("authorization-1");
    const inbox = buildInbox();
    const result = await enqueueWithAuthoritativeStamp({
      authorizationStore: buildStore(),
      inbox,
      authorizationIdentifier: "authorization-1",
      nowIso,
      enqueueInput: baseEnqueueInput({
        authorizationEpoch: 99,
        authorizationIdentifier: "authorization-forged",
      }),
    });
    expect(result.kind).toBe("enqueued");
    const message = inbox.getMessage("message-1");
    expect(message?.authorizationEpoch).toBe(1);
    expect(message?.authorizationIdentifier).toBe("authorization-1");
  }, 30_000);

  it("② 已撤销 ⇒ 拒绝盖章且不入箱", async () => {
    await grant("authorization-1");
    await buildStore().revokeAuthorization("authorization-1", "用户撤权");
    const inbox = buildInbox();
    const result = await enqueueWithAuthoritativeStamp({
      authorizationStore: buildStore(),
      inbox,
      authorizationIdentifier: "authorization-1",
      nowIso,
      enqueueInput: baseEnqueueInput(),
    });
    expect(result.kind).toBe("refused");
    expect(inbox.getMessage("message-1")).toBeNull();
  }, 30_000);

  it("③ 已过期 ⇒ 拒绝（即使代际相同也不放行）", async () => {
    await grant("authorization-1", { expiresAtIso: "2026-11-18T12:00:00.000Z" });
    const stamp = await resolveAuthorizationStamp({
      authorizationStore: buildStore(),
      authorizationIdentifier: "authorization-1",
      nowIso,
    });
    expect(stamp.kind).toBe("refused");
    expect((stamp as { code: string }).code).toBe("authorization-expired");
  }, 30_000);

  it("④ 权威存储查不到关系 ⇒ 拒绝盖章", async () => {
    const stamp = await resolveAuthorizationStamp({
      authorizationStore: buildStore(),
      authorizationIdentifier: "authorization-unknown",
      nowIso,
    });
    expect(stamp.kind).toBe("refused");
    expect((stamp as { code: string }).code).toBe("authorization-missing");
  }, 30_000);
});
