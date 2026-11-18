/**
 * WIRING-04 §36.2 反例：跨项目协作账本（2026-11-19）。
 *
 * 账本是"先读去重、再追加"的读-改-写：并发发送若互相覆盖，
 * 会丢掉已发记录（导致同一消息被重复发送/回复无法沿原路返回）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import {
  issueCrossProjectAuthorization,
  type CrossProjectAuthorization,
  type CrossProjectEnvelope,
} from "../../../packages/core/src/orchestration/cross-project-collaboration.js";
import { sendCrossProjectMessage } from "../../../packages/core/src/orchestration/cross-project-transport.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

const nowIso = "2026-11-18T12:00:00.000Z";

function authorization(): CrossProjectAuthorization {
  const outcome = issueCrossProjectAuthorization({
    authorizationIdentifier: "auth-1",
    sourceProjectIdentifier: "project-a",
    targetProjectIdentifier: "project-b",
    requestingAgentInstanceId: "agent-a1",
    grantor: { kind: "authenticated-user", userId: "user-1" },
    scope: { kind: "specific-agent", agentInstanceId: "agent-b1" },
    allowedMessageKinds: ["status-query", "suggestion", "correlated-reply"],
    purpose: "只读查询",
    issuedAtIso: "2026-11-18T10:00:00.000Z",
    expiresAtIso: "2026-11-19T10:00:00.000Z",
    revision: 1,
  });
  if (outcome.kind !== "granted") {
    throw new Error("夹具授权应成功");
  }
  return outcome.authorization;
}

function envelope(idempotencyKey: string): CrossProjectEnvelope {
  return {
    messageIdentifier: randomUUID(),
    idempotencyKey,
    senderAgentInstanceId: "agent-a1",
    recipientAgentInstanceId: "agent-b1",
    sourceProjectIdentifier: "project-a",
    targetProjectIdentifier: "project-b",
    sourceSessionIdentifier: "session-a",
    targetSessionIdentifier: null,
    missionIdentifier: "mission-1",
    taskIdentifier: "task-1",
    authorizationRevision: 1,
    messageKind: "status-query",
    correlationIdentifier: null,
    replyToMessageIdentifier: null,
    intendedAction: "read",
  };
}

describe("WIRING-04 §36.2：跨项目账本并发", () => {
  it("① 两个实例并发发送 40 条不同消息 ⇒ 账本保留 40 条", async () => {
    const firstJournal = new MailboxJournal(stateDirectory);
    const secondJournal = new MailboxJournal(stateDirectory);
    const sends: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      sends.push(
        sendCrossProjectMessage({
          baseDirectory: stateDirectory,
          journal: firstJournal,
          envelope: envelope(`idem-a-${String(index)}`),
          authorization: authorization(),
          nowIso,
        }),
        sendCrossProjectMessage({
          baseDirectory: stateDirectory,
          journal: secondJournal,
          envelope: envelope(`idem-b-${String(index)}`),
          authorization: authorization(),
          nowIso,
        }),
      );
    }
    await Promise.all(sends);

    const ledger = JSON.parse(
      await fs.readFile(
        path.join(stateDirectory, "collaboration", "cross-project-ledger.json"),
        "utf8",
      ),
    ) as { entries: Array<{ idempotencyKey: string }> };
    expect(ledger.entries).toHaveLength(40);
  }, 60_000);
});
