/**
 * 协作状态只读视图（此前 `tests/` 零引用）。
 *
 * 纪律：不写盘 / 不投递 / 不改归属；`failed` 必须映射为 `dropped`（如实表现"送不到"）；
 * 损坏收件箱要计数而不是掩盖；空状态要说明"空 ≠ 不存在"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { buildCollaborationStatusFromState } from "../../../packages/core/src/orchestration/collaboration-status.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "collab-status-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildRegistry(records: Array<{ agentInstanceId: string; createdByAgentInstanceId: string; recycledAtIso: string | null }>) {
  return { listAllRecords: async () => records } as never;
}

function message(overrides: Record<string, unknown>) {
  return {
    messageIdentifier: "message-1",
    correlationIdentifier: "correlation-1",
    recipientAgentInstanceId: "agent-1",
    senderAgentInstanceId: "agent-0",
    originalSourceAgentInstanceId: "agent-0",
    isRelayedRequest: false,
    taskIdentifier: "T-001",
    state: "received",
    ...overrides,
  };
}

function buildInboxStore(inboxes: Record<string, unknown>) {
  return {
    listInboxes: async () => ({
      inboxes: Object.keys(inboxes).map((recipientAgentInstanceId) => ({ recipientAgentInstanceId })),
    }),
    read: async (recipientAgentInstanceId: string) => inboxes[recipientAgentInstanceId],
  } as never;
}

describe("协作状态只读视图", () => {
  it("① 空状态 ⇒ 空列表 + 明确说明「空 ≠ 不存在」", async () => {
    const snapshot = await buildCollaborationStatusFromState({
      stateDirectory,
      registry: buildRegistry([]),
      inboxStore: buildInboxStore({}),
    });
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.deliveries).toEqual([]);
    expect(snapshot.inboxFileCount).toBe(0);
    expect(snapshot.invalidInboxCount).toBe(0);
    expect(snapshot.notice).toContain("空 ≠ 不存在");
  });

  it("② 状态映射：failed ⇒ dropped（不伪装已投递），未知状态也按 dropped", async () => {
    const snapshot = await buildCollaborationStatusFromState({
      stateDirectory,
      registry: buildRegistry([]),
      inboxStore: buildInboxStore({
        "agent-1": {
          kind: "valid",
          snapshot: {
            messages: [
              message({ messageIdentifier: "m-received", state: "received" }),
              message({ messageIdentifier: "m-delivered", state: "delivered" }),
              message({ messageIdentifier: "m-processed", state: "processed" }),
              message({ messageIdentifier: "m-completed", state: "completed" }),
              message({ messageIdentifier: "m-failed", state: "failed" }),
              message({ messageIdentifier: "m-unknown", state: "something-else" }),
            ],
          },
        },
      }),
    });
    const stateById = new Map(snapshot.deliveries.map((delivery) => [delivery.deliveryIdentifier, delivery.state]));
    expect(stateById.get("m-received")).toBe("pending");
    expect(stateById.get("m-delivered")).toBe("delivered");
    expect(stateById.get("m-processed")).toBe("delivered");
    expect(stateById.get("m-completed")).toBe("delivered");
    expect(stateById.get("m-failed")).toBe("dropped");
    expect(stateById.get("m-unknown")).toBe("dropped");
  });

  it("③ 损坏收件箱 ⇒ 计数而不是掩盖，其它收件箱照常统计", async () => {
    const snapshot = await buildCollaborationStatusFromState({
      stateDirectory,
      registry: buildRegistry([]),
      inboxStore: buildInboxStore({
        "agent-broken": { kind: "invalid", reason: "JSON 损坏" },
        "agent-ok": {
          kind: "valid",
          snapshot: { messages: [message({ messageIdentifier: "m-ok", state: "received" })] },
        },
      }),
    });
    expect(snapshot.invalidInboxCount).toBe(1);
    expect(snapshot.inboxFileCount).toBe(2);
    expect(snapshot.deliveries.map((delivery) => delivery.deliveryIdentifier)).toEqual(["m-ok"]);
  });

  it("④ 已回收 Agent ⇒ isActive=false；未回收 ⇒ true", async () => {
    const snapshot = await buildCollaborationStatusFromState({
      stateDirectory,
      registry: buildRegistry([
        { agentInstanceId: "agent-live", createdByAgentInstanceId: "main-1", recycledAtIso: null },
        { agentInstanceId: "agent-recycled", createdByAgentInstanceId: "main-1", recycledAtIso: "2026-11-12T00:00:00.000Z" },
      ]),
      inboxStore: buildInboxStore({}),
    });
    const byId = new Map(snapshot.agents.map((agent) => [agent.agentInstanceIdentifier, agent.isActive]));
    expect(byId.get("agent-live")).toBe(true);
    expect(byId.get("agent-recycled")).toBe(false);
  });

  it("⑤ 有数据时 notice 明确「只读视图」", async () => {
    const snapshot = await buildCollaborationStatusFromState({
      stateDirectory,
      registry: buildRegistry([
        { agentInstanceId: "agent-1", createdByAgentInstanceId: "main-1", recycledAtIso: null },
      ]),
      inboxStore: buildInboxStore({}),
    });
    expect(snapshot.notice).toContain("只读视图");
  });

  it("⑥ 真实收件箱目录：查询不写盘（不新建文件、不改内容）", async () => {
    const inboxStore = new CollaborationInboxStore({ baseDirectory: stateDirectory });
    await buildCollaborationStatusFromState({ stateDirectory, registry: buildRegistry([]), inboxStore });

    const inboxDirectory = path.join(stateDirectory, "collaboration", "inbox");
    const existsAfter = await fs
      .stat(inboxDirectory)
      .then(() => true)
      .catch(() => false);
    expect(existsAfter).toBe(false);

    const entriesAfter = await fs.readdir(stateDirectory);
    expect(entriesAfter).toEqual([]);
  });
});
