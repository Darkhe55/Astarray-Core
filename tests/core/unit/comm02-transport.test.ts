/**
 * COMM-01-02 真实传输反例（2026-10-22）：跨项目只读消息落到**本机 mailbox**。
 *
 * 覆盖：允许才写入（拒绝时 didWriteMailbox=false）、幂等抑制（同 idempotencyKey）、
 * 账本损坏保守拒绝、接收者隔离、只读动作、回复关联字段保留、重启后幂等仍生效。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { MailboxJournal } from "../../../packages/core/src/feedback-process/mailbox-journal.js";
import {
  issueCrossProjectAuthorization,
  type CrossProjectAuthorization,
  type CrossProjectEnvelope,
} from "../../../packages/core/src/orchestration/cross-project-collaboration.js";
import { sendCrossProjectMessage } from "../../../packages/core/src/orchestration/cross-project-transport.js";

const temporaryDirectories: string[] = [];

async function createWorkspace() {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-comm02-transport-"));
  temporaryDirectories.push(baseDirectory);
  return { baseDirectory, journal: new MailboxJournal(baseDirectory) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const nowIso = "2026-10-22T12:00:00.000Z";

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
    issuedAtIso: "2026-10-22T10:00:00.000Z",
    expiresAtIso: "2026-10-23T10:00:00.000Z",
    revision: 1,
  });
  if (outcome.kind !== "granted") throw new Error("夹具授权应成功");
  return outcome.authorization;
}

function envelope(overrides: Partial<CrossProjectEnvelope> = {}): CrossProjectEnvelope {
  return {
    messageIdentifier: randomUUID(),
    idempotencyKey: "idem-transport-1",
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
    ...overrides,
  };
}

describe("COMM-01-02 跨项目真实传输", () => {
  it("① 授权通过 ⇒ 写入目标 mailbox，返回 mailboxSequence", async () => {
    const { baseDirectory, journal } = await createWorkspace();
    const outcome = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope(),
      authorization: authorization(),
      nowIso,
    });
    expect(outcome).toMatchObject({ kind: "queued", recipientAgentInstanceId: "agent-b1" });
    expect(await journal.countPending("agent-b1")).toBe(1);
    // 只写目标接收者，不写别人
    expect(await journal.countPending("agent-b2")).toBe(0);
  });

  it("② 无授权 ⇒ 拒绝且**不写信箱**", async () => {
    const { baseDirectory, journal } = await createWorkspace();
    const outcome = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope(),
      authorization: null,
      nowIso,
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "authorization-not-found", didWriteMailbox: false });
    expect(await journal.countPending("agent-b1")).toBe(0);
  });

  it("③ 写动作 ⇒ 拒绝且不写信箱（只读协作）", async () => {
    const { baseDirectory, journal } = await createWorkspace();
    const outcome = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope({ intendedAction: "modify-task-graph" }),
      authorization: authorization(),
      nowIso,
    });
    expect(outcome).toMatchObject({ kind: "rejected", reasonCode: "write-action-forbidden" });
    expect(await journal.countPending("agent-b1")).toBe(0);
  });

  it("④ 同 idempotencyKey 重复发送 ⇒ duplicate-suppressed，不重复入池", async () => {
    const { baseDirectory, journal } = await createWorkspace();
    const first = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope(),
      authorization: authorization(),
      nowIso,
    });
    const second = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope({ messageIdentifier: randomUUID() }),
      authorization: authorization(),
      nowIso,
    });
    expect(first.kind).toBe("queued");
    expect(second).toMatchObject({ kind: "duplicate-suppressed" });
    if (first.kind === "queued" && second.kind === "duplicate-suppressed") {
      expect(second.mailboxSequence).toBe(first.mailboxSequence);
    }
    expect(await journal.countPending("agent-b1")).toBe(1);
  });

  it("⑤ 重启（新 journal/transport 实例）后幂等仍生效（账本落盘）", async () => {
    const { baseDirectory, journal } = await createWorkspace();
    await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope(),
      authorization: authorization(),
      nowIso,
    });
    const restartedJournal = new MailboxJournal(baseDirectory);
    const replay = await sendCrossProjectMessage({
      baseDirectory,
      journal: restartedJournal,
      envelope: envelope(),
      authorization: authorization(),
      nowIso,
    });
    expect(replay.kind).toBe("duplicate-suppressed");
  });

  it("⑥ 账本损坏 ⇒ 保守拒绝（不冒重复投递风险）", async () => {
    const { baseDirectory, journal } = await createWorkspace();
    const ledgerDirectory = path.join(baseDirectory, "collaboration");
    await import("node:fs/promises").then((module) => module.mkdir(ledgerDirectory, { recursive: true }));
    await writeFile(path.join(ledgerDirectory, "cross-project-ledger.json"), "{ broken", "utf8");
    const outcome = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope(),
      authorization: authorization(),
      nowIso,
    });
    expect(outcome).toMatchObject({ kind: "rejected", didWriteMailbox: false });
    if (outcome.kind === "rejected") {
      expect(outcome.reasonCode).toBe("ledger-unavailable");
    }
  });

  it("⑦ 关联回复保留 correlation 与 replyTo 字段（经信封），且类型须在授权范围", async () => {
    const { baseDirectory, journal } = await createWorkspace();
    const reply = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope({
        messageKind: "correlated-reply",
        correlationIdentifier: "corr-1",
        replyToMessageIdentifier: "message-original",
      }),
      authorization: authorization(),
      nowIso,
    });
    expect(reply.kind).toBe("queued");
    const wrongKind = await sendCrossProjectMessage({
      baseDirectory,
      journal,
      envelope: envelope({ idempotencyKey: "idem-2", messageKind: "artifact-query" }),
      authorization: authorization(),
      nowIso,
    });
    expect(wrongKind).toMatchObject({ kind: "rejected", reasonCode: "message-kind-not-allowed" });
  });
});

