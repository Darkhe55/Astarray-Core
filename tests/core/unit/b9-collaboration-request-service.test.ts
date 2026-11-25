/**
 * B9（2026-11-25）：协作请求服务的拒绝分支与幂等。
 *
 * 纪律：未知/已回收收件人、自指、跨项目缺授权、越级直达都必须**如实拒绝**；同 requestIdentifier 幂等。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import { sendCollaborationRequest } from "../../../packages/core/src/orchestration/collaboration-request-service.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-collab-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    senderAgentInstanceId: "agent-1",
    recipientAgentInstanceId: "agent-2",
    taskIdentifier: "T-1",
    summary: "协作请求",
    nowIso: "2026-11-25T00:00:00.000Z",
    projectScope: "same-project" as const,
    ...overrides,
  };
}

async function deps(input: {
  isRecipientKnown?: (id: string) => Promise<boolean>;
  uniqueParentOf?: (id: string) => Promise<string | null>;
}) {
  return {
    inboxStore: new CollaborationInboxStore({ baseDirectory }),
    authorizationStore: new CrossProjectAuthorizationStore({ baseDirectory }),
    isRecipientKnown: input.isRecipientKnown ?? (async () => true),
    uniqueParentOf: input.uniqueParentOf ?? (async () => null),
  };
}

describe("B9：协作请求服务拒绝分支", () => {
  it("① 自指 ⇒ refused self-addressed", async () => {
    const outcome = await sendCollaborationRequest(
      await deps({}),
      baseInput({ recipientAgentInstanceId: "agent-1" }) as never,
    );
    expect(outcome).toMatchObject({ kind: "refused", code: "self-addressed" });
  });

  it("② 收件人未登记 ⇒ recipient-not-a-known-agent", async () => {
    const outcome = await sendCollaborationRequest(
      await deps({ isRecipientKnown: async () => false }),
      baseInput() as never,
    );
    expect(outcome).toMatchObject({ kind: "refused", code: "recipient-not-a-known-agent" });
  });

  it("③ 四级越级直达 ⇒ relay-required（须由直属上级转达）", async () => {
    const outcome = await sendCollaborationRequest(
      await deps({
        isRecipientKnown: async () => true,
        /** 发送者的唯一直属上级是 agent-9，而不是收件人 agent-2。 */
        uniqueParentOf: async (id) => (id === "agent-1" ? "agent-9" : "agent-1"),
      }),
      baseInput({ senderRole: "quaternary" }) as never,
    );
    expect(outcome).toMatchObject({ kind: "refused", code: "relay-required" });
  });

  it("④ 跨项目缺授权 ⇒ authorization-missing", async () => {
    const outcome = await sendCollaborationRequest(
      await deps({}),
      baseInput({
        projectScope: "cross-project",
        sourceProjectIdentifier: "project-a",
        targetProjectIdentifier: "project-b",
      }) as never,
    );
    expect(outcome).toMatchObject({ kind: "refused", code: "authorization-missing" });
  });

  it("⑤ 同项目已登记收件人 + 无传输 ⇒ sent 且标记未投递", async () => {
    const outcome = await sendCollaborationRequest(await deps({}), baseInput() as never);
    expect(outcome.kind).toBe("sent");
    if (outcome.kind === "sent") {
      expect(typeof outcome.messageIdentifier).toBe("string");
      expect(typeof outcome.isDelivered).toBe("boolean");
    }
  });

  it("⑥ 同一 requestIdentifier 幂等 ⇒ duplicate 复用同一 messageIdentifier", async () => {
    const serviceDeps = await deps({});
    const first = await sendCollaborationRequest(
      serviceDeps,
      baseInput({ requestIdentifier: "req-1" }) as never,
    );
    const second = await sendCollaborationRequest(
      serviceDeps,
      baseInput({ requestIdentifier: "req-1" }) as never,
    );
    expect(first.kind).toBe("sent");
    expect(second.kind).toBe("duplicate");
    if (first.kind === "sent" && second.kind === "duplicate") {
      expect(second.messageIdentifier).toBe(first.messageIdentifier);
    }
  });
});
