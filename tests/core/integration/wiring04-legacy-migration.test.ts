/**
 * WIRING-04-01 旧状态迁移（2026-11-17）：journal 已 applied 但无业务意图。
 *
 * 核心纪律：**不自动重放**。有权威同消息证据才补 completed，否则标 needs-reconciliation。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import { CoordinationTaskApplicationLedger } from "../../../packages/core/src/orchestration/coordination-task-application-ledger.js";
import { migrateLegacyAppliedMessagesWithoutIntent } from "../../../packages/core/src/orchestration/coordination-legacy-migration.js";

vi.setConfig({ testTimeout: 60_000 });

const RECIPIENT_ID = "scheduler:mission-1";
let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-migrate-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function enqueueLegacyAppliedMessage(journal: MailboxJournal, messageId: string) {
  await journal.enqueue({
    protocolVersion: 1,
    messageId,
    source: { sourceType: "agent", agentInstanceId: "worker-1" },
    recipientId: RECIPIENT_ID,
    priority: "state",
    createdAtIso: "2026-11-17T00:00:00.000Z",
    idempotencyKey: messageId,
    missionIdentifier: "mission-1",
    payload: { kind: "success", summary: "历史消息" },
  } as never);
  /** 旧行为：只写 journal applied，没有业务意图。 */
  await journal.recordApplicationState({
    recipientId: RECIPIENT_ID,
    messageId,
    state: "applied",
    reason: null,
    targetStateVersion: 1,
    updatedAtIso: "2026-11-17T00:00:00.000Z",
  });
}

describe("WIRING-04-01 旧状态迁移", () => {
  it("① applied 无意图且无权威证据 ⇒ needs-reconciliation，不自动重放", async () => {
    const journal = new MailboxJournal(stateDirectory);
    const ledger = new CoordinationTaskApplicationLedger({
      baseDirectory: stateDirectory,
      nowIso: () => "2026-11-17T00:00:00.000Z",
    });
    await enqueueLegacyAppliedMessage(journal, "legacy-1");

    const result = await migrateLegacyAppliedMessagesWithoutIntent({
      journal,
      ledger,
      isAppliedInAuthoritativeState: async () => false,
    });

    expect(result.scannedMessageCount).toBe(1);
    expect(result.markedNeedsReconciliationCount).toBe(1);
    expect(result.completedFromEvidenceCount).toBe(0);
    const entry = (await ledger.readAll()).get("legacy-1");
    expect(entry?.status).toBe("needs-reconciliation");
    expect(entry?.reason).toContain("不自动重放");
  });

  it("② applied 无意图但有权威证据 ⇒ 补 completed", async () => {
    const journal = new MailboxJournal(stateDirectory);
    const ledger = new CoordinationTaskApplicationLedger({
      baseDirectory: stateDirectory,
      nowIso: () => "2026-11-17T00:00:00.000Z",
    });
    await enqueueLegacyAppliedMessage(journal, "legacy-2");

    const result = await migrateLegacyAppliedMessagesWithoutIntent({
      journal,
      ledger,
      isAppliedInAuthoritativeState: async () => true,
    });

    expect(result.completedFromEvidenceCount).toBe(1);
    expect((await ledger.readAll()).get("legacy-2")?.status).toBe("completed");
  });

  it("③ 迁移前生成备份文件（失败不覆盖旧文件的前提）", async () => {
    const journal = new MailboxJournal(stateDirectory);
    const ledger = new CoordinationTaskApplicationLedger({
      baseDirectory: stateDirectory,
      nowIso: () => "2026-11-17T00:00:00.000Z",
    });
    /** 先写一条历史台账内容，确保备份有内容可备。 */
    await ledger.recordIntent({
      messageIdentifier: "already-tracked",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-1",
    });
    await enqueueLegacyAppliedMessage(journal, "legacy-3");

    const result = await migrateLegacyAppliedMessagesWithoutIntent({
      journal,
      ledger,
      isAppliedInAuthoritativeState: async () => false,
    });

    expect(result.backupPath).not.toBeNull();
    const backupContent = await fs.readFile(result.backupPath as string, "utf8");
    expect(backupContent).toContain("already-tracked");
  });

  it("④ 已有意图记录的消息不被迁移改写", async () => {
    const journal = new MailboxJournal(stateDirectory);
    const ledger = new CoordinationTaskApplicationLedger({
      baseDirectory: stateDirectory,
      nowIso: () => "2026-11-17T00:00:00.000Z",
    });
    await ledger.recordIntent({
      messageIdentifier: "legacy-4",
      missionIdentifier: "mission-1",
      taskIdentifier: "T-1",
    });
    await enqueueLegacyAppliedMessage(journal, "legacy-4");

    const result = await migrateLegacyAppliedMessagesWithoutIntent({
      journal,
      ledger,
      isAppliedInAuthoritativeState: async () => false,
    });

    expect(result.scannedMessageCount).toBe(0);
    expect((await ledger.readAll()).get("legacy-4")?.status).toBe("pending");
  });
});
