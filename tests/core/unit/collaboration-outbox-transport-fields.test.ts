/**
 * 协作 outbox 落盘字段（2026-11-15，COMM-01 裁决第 1 条）。
 *
 * 这是一个**静默丢字段**的反例：消息对象上有 `missionIdentifier` /
 * `replyToMessageIdentifier`，但写出到队列文件时只写固定字段，
 * 于是标记"在路上"消失，接收方回复必然被拒。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationOutboxTransport } from "../../../packages/core/src/orchestration/collaboration-outbox-transport.js";
import type { CollaborationInboxMessage } from "../../../packages/core/src/orchestration/collaboration-inbox.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "collab-outbox-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildMessage(overrides: Record<string, unknown> = {}): CollaborationInboxMessage {
  return {
    messageIdentifier: "message-1",
    correlationIdentifier: "corr-1",
    recipientAgentInstanceId: "agent-b1",
    senderAgentInstanceId: "agent-a1",
    originalSourceAgentInstanceId: "agent-a1",
    isRelayedRequest: false,
    taskIdentifier: "task-1",
    artifactReferenceStatus: "not-provided",
    summary: "请查询状态",
    receivedAtIso: "2026-11-15T00:00:00.000Z",
    authorizationEpoch: 1,
    state: "received",
    deliveryAttemptCount: 0,
    lastFailureAtIso: null,
    ...overrides,
  } as unknown as CollaborationInboxMessage;
}

async function readQueuedDocument(transport: CollaborationOutboxTransport, recipient: string) {
  const filePath = transport.pathFor(recipient, "message-1");
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("协作 outbox 落盘字段", () => {
  it("① 带 mission ⇒ 落盘文件里必须有 missionIdentifier（否则回复无法定位任务链）", async () => {
    const transport = new CollaborationOutboxTransport({ baseDirectory });
    await transport.send(buildMessage({ missionIdentifier: "mission-1" }));
    const document = await readQueuedDocument(transport, "agent-b1");
    expect(document["missionIdentifier"]).toBe("mission-1");
  });

  it("② 带 replyTo ⇒ 落盘文件里必须有 replyToMessageIdentifier（否则回复指不回原请求）", async () => {
    const transport = new CollaborationOutboxTransport({ baseDirectory });
    await transport.send(buildMessage({ replyToMessageIdentifier: "message-original" }));
    const document = await readQueuedDocument(transport, "agent-b1");
    expect(document["replyToMessageIdentifier"]).toBe("message-original");
  });

  it("③ 未提供时文件形状不变（不写 null，保持向下兼容）", async () => {
    const transport = new CollaborationOutboxTransport({ baseDirectory });
    await transport.send(buildMessage());
    const document = await readQueuedDocument(transport, "agent-b1");
    expect(document["missionIdentifier"]).toBeUndefined();
    expect(document["replyToMessageIdentifier"]).toBeUndefined();
  });

  it("④ 幂等：同消息重复发送不重复写文件（既有行为未回归）", async () => {
    const transport = new CollaborationOutboxTransport({ baseDirectory });
    const first = await transport.send(buildMessage({ missionIdentifier: "mission-1" }));
    const second = await transport.send(buildMessage({ missionIdentifier: "mission-1" }));
    expect(first.isDelivered).toBe(true);
    expect(second.isDelivered).toBe(true);
    expect(second.reason).toContain("已存在同一消息");
  });
});
