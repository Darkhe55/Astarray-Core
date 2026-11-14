/**
 * COMM-01-02 真实传输（2026-10-22）：跨项目**只读**消息落到本机 mailbox。
 *
 * 用户口径：协作通信**采用本机状态**（同一本地状态目录，不引入网络/远程通道）。
 *
 * 纪律：
 * 1. **先判定后落盘**：`evaluateCrossProjectDelivery` 拒绝时**不写信箱**
 *    （`didWriteMailbox:false`），不会留下"半条消息"；
 * 2. **幂等**：同 `idempotencyKey` 重复发送由本机目录账本抑制，返回原 `mailboxSequence`；
 * 3. **账本损坏 ⇒ 保守拒绝**（`ledger-unavailable`），宁可拒绝也不重复投递；
 * 4. 只写**目标接收者的 mailbox**（复用 `MailboxJournal`），不写其他个体；
 * 5. 只读动作由契约层保证（写动作在判定阶段已拒），本模块不提供旁路。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import type { MailboxJournal } from "../feedback-process/mailbox-journal.js";
import {
  evaluateCrossProjectDelivery,
  type CrossProjectAuthorization,
  type CrossProjectEnvelope,
  type CrossProjectTargetLifecycle,
} from "./cross-project-collaboration.js";

/** 本机跨项目账本（幂等索引）。 */
interface CrossProjectDeliveryLedgerDocument {
  readonly schemaVersion: 1;
  readonly entries: ReadonlyArray<{
    readonly idempotencyKey: string;
    readonly messageIdentifier: string;
    /** COMM-01：原请求发起者，用于证明"回复沿原路返回"。旧账本无此字段 ⇒ 回复被保守拒绝。 */
    readonly senderAgentInstanceId: string;
    readonly recipientAgentInstanceId: string;
    readonly mailboxSequence: number;
    readonly recordedAtIso: string;
  }>;
}

/** 发送结果。 */
export type CrossProjectSendOutcome =
  | {
      readonly kind: "queued";
      readonly mailboxSequence: number;
      readonly recipientAgentInstanceId: string;
    }
  | {
      readonly kind: "duplicate-suppressed";
      readonly mailboxSequence: number;
      readonly recipientAgentInstanceId: string;
    }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "authorization-not-found"
        | "authorization-revoked"
        | "authorization-expired"
        | "authorization-revision-stale"
        | "wrong-source-project"
        | "wrong-target-project"
        | "sender-not-authorized-agent"
        | "role-scope-mismatch"
        | "message-kind-not-allowed"
        | "write-action-forbidden"
        | "receiver-unavailable"
        | "envelope-incomplete"
        | "reply-without-original"
      | "reply-target-mismatch"
      | "ledger-unavailable";
      readonly reason: string;
      readonly didWriteMailbox: false;
    };

const LEDGER_FILE_NAME = "cross-project-ledger.json";

function ledgerFilePath(baseDirectory: string): string {
  return path.join(baseDirectory, "collaboration", LEDGER_FILE_NAME);
}

async function loadLedger(
  baseDirectory: string,
): Promise<CrossProjectDeliveryLedgerDocument> {
  const filePath = ledgerFilePath(baseDirectory);
  // 契约：文件不存在返回 null；损坏时抛错（由调用方保守拒绝）
  const result = await readJsonWithBackupRecovery(filePath, filePath + ".bak");
  if (result === null) {
    return { schemaVersion: 1, entries: [] };
  }
  const document = result.content as Partial<CrossProjectDeliveryLedgerDocument> | null;
  if (
    document === null ||
    typeof document !== "object" ||
    document.schemaVersion !== 1 ||
    !Array.isArray(document.entries)
  ) {
    throw new Error("跨项目账本结构不合法");
  }
  return { schemaVersion: 1, entries: document.entries };
}

/** 发送一条跨项目消息（只读协作）。 */
export async function sendCrossProjectMessage(input: {
  readonly baseDirectory: string;
  readonly journal: MailboxJournal;
  readonly envelope: CrossProjectEnvelope;
  readonly authorization: CrossProjectAuthorization | null;
  readonly nowIso: string;
  readonly targetLifecycle?: CrossProjectTargetLifecycle;
  readonly targetRoleIdentifiers?: ReadonlyArray<string>;
}): Promise<CrossProjectSendOutcome> {
  /**
   * COMM-01（2026-11-14 用户裁决第 1 条）：**先取账本，再判定**。
   *
   * 回复是否"沿原路返回"只能靠本机账本证明（原请求的发起者是谁）；
   * 因此账本必须先读到，判定时才能带上 `originalDeliveredMessage`。
   * 账本不可用 ⇒ 保守拒绝（原实现亦如此）。
   */
  let ledger: CrossProjectDeliveryLedgerDocument;
  try {
    ledger = await loadLedger(input.baseDirectory);
  } catch (error) {
    return {
      kind: "rejected",
      reasonCode: "ledger-unavailable",
      reason:
        "本机跨项目账本不可用：" +
        (error instanceof Error ? error.message : String(error)) +
        "；保守拒绝，避免重复投递。",
      didWriteMailbox: false,
    };
  }

  const replyToMessageIdentifier = input.envelope.replyToMessageIdentifier;
  const originalLedgerEntry =
    replyToMessageIdentifier === null
      ? undefined
      : ledger.entries.find(
          (entry) => entry.messageIdentifier === replyToMessageIdentifier,
        );
  const originalDeliveredMessage =
    originalLedgerEntry === undefined
      ? null
      : {
          messageIdentifier: originalLedgerEntry.messageIdentifier,
          senderAgentInstanceId: originalLedgerEntry.senderAgentInstanceId,
          recipientAgentInstanceId: originalLedgerEntry.recipientAgentInstanceId,
        };

  const decision = evaluateCrossProjectDelivery({
    envelope: input.envelope,
    authorization: input.authorization,
    nowIso: input.nowIso,
    originalDeliveredMessage,
    ...(input.targetLifecycle === undefined ? {} : { targetLifecycle: input.targetLifecycle }),
    ...(input.targetRoleIdentifiers === undefined
      ? {}
      : { targetRoleIdentifiers: input.targetRoleIdentifiers }),
  });
  if (decision.kind === "rejected") {
    return {
      kind: "rejected",
      reasonCode: decision.reasonCode,
      reason: decision.reason,
      didWriteMailbox: false,
    };
  }

  const existing = ledger.entries.find(
    (entry) =>
      entry.idempotencyKey === input.envelope.idempotencyKey &&
      entry.recipientAgentInstanceId === input.envelope.recipientAgentInstanceId,
  );
  if (existing !== undefined) {
    return {
      kind: "duplicate-suppressed",
      mailboxSequence: existing.mailboxSequence,
      recipientAgentInstanceId: existing.recipientAgentInstanceId,
    };
  }

  const mailboxSequence = await input.journal.enqueue({
    protocolVersion: 1,
    messageId: input.envelope.messageIdentifier,
    source: {
      sourceType: "agent",
      agentInstanceId: input.envelope.senderAgentInstanceId,
      agentRole: "main",
    },
    recipientId: input.envelope.recipientAgentInstanceId,
    priority: "instruction",
    createdAtIso: input.nowIso,
    idempotencyKey: input.envelope.idempotencyKey,
    payload: {
      kind: "instruction",
      instructionText:
        "[cross-project/" +
        input.envelope.messageKind +
        "] 只读协作消息（项目 " +
        input.envelope.sourceProjectIdentifier +
        " → " +
        input.envelope.targetProjectIdentifier +
        "）",
    },
  });

  const nextLedger: CrossProjectDeliveryLedgerDocument = {
    schemaVersion: 1,
    entries: [
      ...ledger.entries,
      {
        idempotencyKey: input.envelope.idempotencyKey,
        messageIdentifier: input.envelope.messageIdentifier,
        senderAgentInstanceId: input.envelope.senderAgentInstanceId,
        recipientAgentInstanceId: input.envelope.recipientAgentInstanceId,
        mailboxSequence,
        recordedAtIso: input.nowIso,
      },
    ],
  };
  await fs.mkdir(path.dirname(ledgerFilePath(input.baseDirectory)), { recursive: true });
  await writeAtomicJson(ledgerFilePath(input.baseDirectory), nextLedger);

  return {
    kind: "queued",
    mailboxSequence,
    recipientAgentInstanceId: input.envelope.recipientAgentInstanceId,
  };
}


