/**
 * COMM-01-03 `collaboration status` 只读 CLI 反例（2026-10-24）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentCreationRegistry } from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";
import { CollaborationInbox } from "../../../packages/core/src/orchestration/collaboration-inbox.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";
import { executeCollaborationStatusCommand } from "../../../packages/tui/src/cli/collaboration-command.js";

const temporaryDirectories: string[] = [];
async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-collab-status-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("COMM-01-03 collaboration status", () => {
  it("① 输出 Agent 归属与投递状态；failed 映射为 dropped；视图只读", async () => {
    const stateDirectory = await createBaseDirectory();
    const registry = new AgentCreationRegistry({ stateDirectory });
    await registry.registerCreatedAgent({ agentInstanceId: "agent-root", createdByAgentInstanceId: null });
    await registry.registerCreatedAgent({ agentInstanceId: "agent-b", createdByAgentInstanceId: "agent-root" });

    const store = new CollaborationInboxStore({ baseDirectory: stateDirectory });
    const inbox = new CollaborationInbox({ maximumPendingPerRecipient: 5, maximumDeliveryAttempts: 1 });
    inbox.enqueue({
      messageIdentifier: "m-pending",
      correlationIdentifier: "c-1",
      recipientAgentInstanceId: "agent-b",
      senderAgentInstanceId: "agent-root",
      taskIdentifier: "task-1",
      summary: "待投递",
      receivedAtIso: "2026-10-24T00:00:00.000Z",
    });
    inbox.enqueue({
      messageIdentifier: "m-failed",
      correlationIdentifier: "c-2",
      recipientAgentInstanceId: "agent-b",
      senderAgentInstanceId: "agent-root",
      taskIdentifier: "task-2",
      summary: "会失败",
      receivedAtIso: "2026-10-24T00:00:00.000Z",
    });
    inbox.recordDeliveryFailure("m-failed", "2026-10-24T00:00:01.000Z");
    await store.save("agent-b", { messages: inbox.toSnapshot(), expectedRevision: 0, updatedAtIso: "2026-10-24T00:00:02.000Z" });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeCollaborationStatusCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.agents).toHaveLength(2);
    const states = payload.deliveries.map((delivery: { state: string }) => delivery.state).sort();
    expect(states).toEqual(["dropped", "pending"]);
    expect(payload.view.isWritable).toBe(false);
    expect(payload.inboxFileCount).toBe(1);
  });

  it("② 空状态 ⇒ 明确「空 ≠ 不存在」，不伪造计数", async () => {
    const stateDirectory = await createBaseDirectory();
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    const exitCode = await executeCollaborationStatusCommand({ stateDirectory, isJsonOutput: true });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(chunks.join(""));
    expect(payload.agents).toHaveLength(0);
    expect(payload.deliveries).toHaveLength(0);
    expect(payload.notice).toContain("空 ≠");
  });
});
