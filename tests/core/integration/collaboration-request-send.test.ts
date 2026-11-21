/**
 * 2026-11-21（用户裁决）：协作请求的生产发送入口。
 *
 * 覆盖：同项目默认关系自动登记（epoch 1）、跨项目显式授权、地址完整性、自我发送、
 * 三级只能经直属上级、幂等 requestIdentifier、撤销后不自动复活、读取出口可见且只读。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import { createCollaborationInboxReadPort } from "../../../packages/core/src/orchestration/collaboration-inbox-read.js";
import { sendCollaborationRequest } from "../../../packages/core/src/orchestration/collaboration-request-service.js";
import type { CollaborationInboxMessage } from "../../../packages/core/src/orchestration/collaboration-inbox.js";

let stateDirectory: string;
let inboxStore: CollaborationInboxStore;
let authorizationStore: CrossProjectAuthorizationStore;
let sentMessages: CollaborationInboxMessage[];

const nowIso = "2026-11-21T00:00:00.000Z";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "collab-request-send-"));
  inboxStore = new CollaborationInboxStore({ baseDirectory: stateDirectory });
  authorizationStore = new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory });
  sentMessages = [];
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildDeps(overrides: Record<string, unknown> = {}) {
  return {
    inboxStore,
    authorizationStore,
    transport: {
      send: async (message: CollaborationInboxMessage) => {
        sentMessages.push(message);
        return { isDelivered: true, reason: "fake-transport-ok" };
      },
    },
    isRecipientKnown: async (agentInstanceId: string) =>
      ["agent-b1", "agent-parent", "agent-a1"].includes(agentInstanceId),
    uniqueParentOf: async (agentInstanceId: string) =>
      agentInstanceId === "agent-t1" ? "agent-parent" : null,
    ...overrides,
  } as never;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    senderAgentInstanceId: "agent-a1",
    recipientAgentInstanceId: "agent-b1",
    taskIdentifier: "T-001",
    summary: "请核对导出结果",
    nowIso,
    projectScope: "same-project" as const,
    ...overrides,
  } as never;
}

describe("协作请求发送入口", () => {
  it("① 同项目：自动登记默认关系（epoch 1）并投递，读取出口可见", async () => {
    const outcome = await sendCollaborationRequest(buildDeps(), baseInput());
    expect(outcome.kind).toBe("sent");
    if (outcome.kind !== "sent") {
      return;
    }
    expect(outcome.authorizationIdentifier).toContain("local-relationship:");
    expect(outcome.authorizationEpoch).toBe(1);
    expect(outcome.inboxState).toBe("delivered");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.authorizationIdentifier).toBe(outcome.authorizationIdentifier);

    const readPort = createCollaborationInboxReadPort({ inboxStore, authorizationStore });
    const view = await readPort.readPendingCollaboration({
      requestingAgentInstanceId: "agent-b1",
    });
    expect(view.isAvailable).toBe(true);
    if (!view.isAvailable) {
      return;
    }
    // 已 delivered ⇒ 不再是"待处理"（received）⇒ 读取视图不返回它（读取≠投递，口径一致）。
    expect(view.items).toHaveLength(0);
    const persisted = await inboxStore.read("agent-b1");
    if (persisted.kind !== "valid") {
      throw new Error("收件箱应可读");
    }
    expect(persisted.snapshot.messages[0]?.authorizationIdentifier).toBe(
      outcome.authorizationIdentifier,
    );
  });

  it("② 未登记/已回收收件人 ⇒ 拒绝（地址完整性）", async () => {
    const unknown = await sendCollaborationRequest(
      buildDeps(),
      baseInput({ recipientAgentInstanceId: "agent-ghost" }),
    );
    expect(unknown).toMatchObject({ kind: "refused", code: "recipient-not-a-known-agent" });

    const recycled = await sendCollaborationRequest(
      buildDeps({ isRecipientKnown: async (id: string) => id !== "agent-ghost" }),
      baseInput({ recipientAgentInstanceId: "agent-ghost" }),
    );
    expect(recycled).toMatchObject({ kind: "refused", code: "recipient-not-a-known-agent" });
  });

  it("③ 发给自己 ⇒ 拒绝", async () => {
    const outcome = await sendCollaborationRequest(
      buildDeps(),
      baseInput({ recipientAgentInstanceId: "agent-a1" }),
    );
    expect(outcome).toMatchObject({ kind: "refused", code: "self-addressed" });
  });

  it("④ 三级发给非直属上级 ⇒ relay-required；发给上级 ⇒ 允许", async () => {
    const blocked = await sendCollaborationRequest(
      buildDeps(),
      baseInput({ senderAgentInstanceId: "agent-t1", senderRole: "tertiary" }),
    );
    expect(blocked).toMatchObject({ kind: "refused", code: "relay-required" });

    const allowed = await sendCollaborationRequest(
      buildDeps(),
      baseInput({
        senderAgentInstanceId: "agent-t1",
        senderRole: "tertiary",
        recipientAgentInstanceId: "agent-parent",
      }),
    );
    expect(allowed.kind).toBe("sent");
  });

  it("⑤ 跨项目缺授权 ⇒ 拒绝；带授权 ⇒ 发同一关系标识", async () => {
    const missing = await sendCollaborationRequest(
      buildDeps(),
      baseInput({ projectScope: "cross-project" }),
    );
    expect(missing).toMatchObject({ kind: "refused", code: "authorization-missing" });

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
    const sent = await sendCollaborationRequest(
      buildDeps(),
      baseInput({
        projectScope: "cross-project",
        authorizationIdentifier: "authorization-1",
        sourceProjectIdentifier: "project-a",
        targetProjectIdentifier: "project-b",
      }),
    );
    expect(sent).toMatchObject({ kind: "sent", authorizationIdentifier: "authorization-1" });
  });

  it("⑥ 同一 requestIdentifier 幂等：第二次 duplicate，不重复入箱", async () => {
    const first = await sendCollaborationRequest(
      buildDeps(),
      baseInput({ requestIdentifier: "req-1" }),
    );
    expect(first.kind).toBe("sent");
    const second = await sendCollaborationRequest(
      buildDeps(),
      baseInput({ requestIdentifier: "req-1" }),
    );
    expect(second.kind).toBe("duplicate");
    if (first.kind !== "sent" || second.kind !== "duplicate") {
      return;
    }
    expect(second.messageIdentifier).toBe(first.messageIdentifier);
    const persisted = await inboxStore.read("agent-b1");
    if (persisted.kind !== "valid") {
      throw new Error("收件箱应可读");
    }
    expect(persisted.snapshot.messages).toHaveLength(1);
  });

  it("⑦ 默认关系被撤销后不自动复活", async () => {
    const first = await sendCollaborationRequest(buildDeps(), baseInput());
    if (first.kind !== "sent") {
      throw new Error("首次应成功");
    }
    await authorizationStore.revokeAuthorization(
      first.authorizationIdentifier,
      "用户撤销同项目关系",
    );
    const second = await sendCollaborationRequest(
      buildDeps(),
      baseInput({ requestIdentifier: "req-2" }),
    );
    expect(second).toMatchObject({ kind: "refused", code: "authorization-revoked" });
  });
});
