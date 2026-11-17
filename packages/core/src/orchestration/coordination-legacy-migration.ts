/**
 * WIRING-04-01 旧状态迁移（2026-11-17）。
 *
 * 背景：早期实现里 journal 可能先被标 `applied`，而**没有**对应的业务意图记录。
 * 这类历史数据不能自动重放（可能有副作用），也不能假装"已完成"。
 *
 * 规则（卡内要求）：
 * - 迁移前备份台账；
 * - 只有**权威任务的同消息应用证据**才能补 `completed`；
 * - 证据不足 ⇒ 标 `needs-reconciliation` 并报告，**不自动重放**；
 * - 不能因为"任务恰好 done"就推断该消息已应用。
 */
import type { MailboxJournal } from "../feedback-process/mailbox-journal.js";
import type { CoordinationTaskApplicationLedger } from "./coordination-task-application-ledger.js";

export async function migrateLegacyAppliedMessagesWithoutIntent(input: {
  readonly journal: MailboxJournal;
  readonly ledger: CoordinationTaskApplicationLedger;
  readonly isAppliedInAuthoritativeState: (input: {
    readonly messageIdentifier: string;
  }) => Promise<boolean>;
}): Promise<{
  readonly backupPath: string | null;
  readonly scannedMessageCount: number;
  readonly markedNeedsReconciliationCount: number;
  readonly completedFromEvidenceCount: number;
}> {
  const existingEntries = await input.ledger.readAll();
  /** 迁移前先备份：失败时不覆盖旧文件（备份失败则整体放弃迁移）。 */
  const backupPath = await input.ledger.createMigrationBackup();

  let scannedMessageCount = 0;
  let markedNeedsReconciliationCount = 0;
  let completedFromEvidenceCount = 0;

  for (const recipientId of await input.journal.listRecipientIds()) {
    const document = await input.journal.loadDocument(recipientId);
    if (document === null) {
      continue;
    }
    for (const message of document.messages) {
      if (message.applicationState?.state !== "applied") {
        continue;
      }
      if (existingEntries.has(message.messageId)) {
        continue;
      }
      scannedMessageCount += 1;
      const hasAuthoritativeEvidence = await input.isAppliedInAuthoritativeState({
        messageIdentifier: message.messageId,
      });
      /** 说明：迁移阶段**不提供**业务应用端口 —— 这条路径永远不重放。 */
      await input.ledger.recordIntent({
        messageIdentifier: message.messageId,
        missionIdentifier: message.missionIdentifier ?? "",
        taskIdentifier: message.taskIdentifier ?? null,
      });
      if (hasAuthoritativeEvidence) {
        await input.ledger.markCompleted({ messageIdentifier: message.messageId });
        completedFromEvidenceCount += 1;
        continue;
      }
      await input.ledger.markNeedsReconciliation({
        messageIdentifier: message.messageId,
        reason:
          "旧数据：journal 已 applied 但无业务意图，且缺少权威应用证据（不自动重放，需对账）",
      });
      markedNeedsReconciliationCount += 1;
    }
  }

  return {
    backupPath,
    scannedMessageCount,
    markedNeedsReconciliationCount,
    completedFromEvidenceCount,
  };
}
