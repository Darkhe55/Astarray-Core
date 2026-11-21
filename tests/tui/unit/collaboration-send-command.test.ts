/**
 * 2026-11-21（用户裁决）：`collaboration send` CLI。
 *
 * 覆盖：已登记收件人 ⇒ 发送成功并落盘；未登记 ⇒ 退出码 1（不猜地址）；
 * 同 requestIdentifier ⇒ 幂等 duplicate；非法/缺失参数由 commander 负责。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeCollaborationSendCommand } from "../../../packages/tui/src/cli/collaboration-send-command.js";
import { AgentCreationRegistry } from "../../../packages/core/src/orchestration/agent-parent-binding-store.js";
import { CollaborationInboxStore } from "../../../packages/core/src/orchestration/collaboration-inbox-store.js";

const temporaryDirectories: string[] = [];

async function createBaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-collab-send-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function captureStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  return chunks;
}

function baseInput(stateDirectory: string, overrides: Record<string, unknown> = {}) {
  return {
    stateDirectory,
    fromAgentInstanceId: "agent-a1",
    toAgentInstanceId: "agent-b1",
    taskIdentifier: "T-001",
    summary: "请核对导出结果",
    missionIdentifier: null,
    replyToMessageIdentifier: null,
    requestIdentifier: null,
    senderRole: null,
    projectScope: "same-project" as const,
    authorizationIdentifier: null,
    sourceProjectIdentifier: null,
    targetProjectIdentifier: null,
    isJsonOutput: true,
    ...overrides,
  } as never;
}

describe("collaboration send CLI", () => {
  it("① 已登记收件人 ⇒ 发送成功并落盘", async () => {
    const stateDirectory = await createBaseDirectory();
    await new AgentCreationRegistry({ stateDirectory }).registerCreatedAgent({
      agentInstanceId: "agent-b1",
      createdByAgentInstanceId: null,
    });
    const chunks = captureStdout();
    const exitCode = await executeCollaborationSendCommand(baseInput(stateDirectory));
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(chunks.join("")) as {
      kind: string;
      authorizationIdentifier: string;
    };
    expect(parsed.kind).toBe("sent");
    expect(parsed.authorizationIdentifier).toContain("local-relationship:");

    const persisted = await new CollaborationInboxStore({ baseDirectory: stateDirectory }).read(
      "agent-b1",
    );
    expect(persisted.kind).toBe("valid");
    if (persisted.kind !== "valid") {
      return;
    }
    expect(persisted.snapshot.messages).toHaveLength(1);
  });

  it("② 未登记收件人 ⇒ 退出码 1（不猜地址）", async () => {
    const stateDirectory = await createBaseDirectory();
    captureStdout();
    const exitCode = await executeCollaborationSendCommand(
      baseInput(stateDirectory, { toAgentInstanceId: "agent-ghost" }),
    );
    expect(exitCode).toBe(1);
  });

  it("③ 同 requestIdentifier 二次发送 ⇒ duplicate（不重复入箱）", async () => {
    const stateDirectory = await createBaseDirectory();
    await new AgentCreationRegistry({ stateDirectory }).registerCreatedAgent({
      agentInstanceId: "agent-b1",
      createdByAgentInstanceId: null,
    });
    captureStdout();
    const first = await executeCollaborationSendCommand(
      baseInput(stateDirectory, { requestIdentifier: "req-1" }),
    );
    expect(first).toBe(0);
    const chunks = captureStdout();
    const second = await executeCollaborationSendCommand(
      baseInput(stateDirectory, { requestIdentifier: "req-1" }),
    );
    expect(second).toBe(0);
    const parsed = JSON.parse(chunks.join("")) as { kind: string };
    expect(parsed.kind).toBe("duplicate");    const persisted = await new CollaborationInboxStore({ baseDirectory: stateDirectory }).read(
      "agent-b1",
    );
    if (persisted.kind !== "valid") {
      throw new Error("收件箱应可读");
    }
    expect(persisted.snapshot.messages).toHaveLength(1);
  });
});
