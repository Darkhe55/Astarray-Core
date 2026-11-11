/**
 * COORD-01-02 修正：收件人 ID 含 `:`（协作前缀 `agent:<id>`）时的**文件名编码**。
 *
 * 真实缺陷：`journalFilePath` 直接用 `${recipientId}.json`，Windows 不允许冒号，
 * 原子写 rename 抛 `EINVAL` —— 即"发给 agent:<id> 的消息根本无法入库"。
 *
 * 反例优先：冒号 ID 能入库并读回；`listRecipientIds` 能还原原始 ID；
 * 普通 ID 的文件名**保持不变**（既有 journal 不受影响）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "coord01-filename-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildMessage(recipientId: string) {
  return {
    protocolVersion: 1,
    messageId: "message-1",
    source: { sourceType: "agent", agentInstanceId: "worker-1" },
    recipientId,
    priority: "state",
    createdAtIso: "2026-11-11T00:00:00.000Z",
    idempotencyKey: "message-1",
    payload: { kind: "success", summary: "完成" },
  } as never;
}

describe("journal 文件名编码", () => {
  it("① 含冒号的收件人 ID 能入库并读回", async () => {
    const journal = new MailboxJournal(stateDirectory);
    await journal.enqueue(buildMessage("agent:main-agent-1"));
    const document = await journal.loadDocument("agent:main-agent-1");
    expect(document?.recipientId).toBe("agent:main-agent-1");
    expect(document?.messages).toHaveLength(1);
  });

  it("② listRecipientIds 还原原始 ID 而不是文件名", async () => {
    const journal = new MailboxJournal(stateDirectory);
    await journal.enqueue(buildMessage("agent:main-agent-1"));
    expect(await journal.listRecipientIds()).toEqual(["agent:main-agent-1"]);
  });

  it("③ 普通 ID 文件名保持不变（既有 journal 兼容）", async () => {
    const journal = new MailboxJournal(stateDirectory);
    await journal.enqueue(buildMessage("worker-1"));
    const collectedFileNames: string[] = [];
    const walk = async (directoryPath: string): Promise<void> => {
      for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
        } else {
          collectedFileNames.push(entry.name);
        }
      }
    };
    await walk(stateDirectory);
    expect(collectedFileNames).toContain("worker-1.json");
  });
});