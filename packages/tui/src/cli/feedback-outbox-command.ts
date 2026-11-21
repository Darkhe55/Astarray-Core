/**
 * 2026-11-21（用户裁决 C）：`feedback-outbox` CLI —— 死信的人工入口。
 *
 * 纪律：
 * - `list` 只读（不重放、不改死信）；损坏文件如实计数，不静默丢弃；
 * - `requeue` 只把死信**原样**写回补送 outbox，是否再次被拒由反馈进程判定；
 * - `remove` 需显式给出文件名（人工确认后清除）；
 * - 非法文件名 ⇒ 退出码 2（防路径穿越/误删）。
 */
import { FeedbackDeadLetterStore } from "../../../core/src/feedback-process/dead-letter.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { EXIT_CODES, printJson, writeDiagnosticText } from "./json-output.js";

export interface FeedbackOutboxListCommandInput {
  readonly stateDirectory: string;
  readonly isJsonOutput: boolean;
}

export async function executeFeedbackOutboxListCommand(
  input: FeedbackOutboxListCommandInput,
): Promise<number> {
  const store = new FeedbackDeadLetterStore({ baseDirectory: input.stateDirectory });
  const outcome = await store.list();
  /** 2026-11-21：补送积压也一并可见（此前 flush 计数被调用方丢弃、完全不可观测）。 */
  const pendingOutboxCount = await fs
    .readdir(path.join(input.stateDirectory, "feedback-client-outbox"))
    .then((names) => names.filter((name) => name.endsWith(".json")).length)
    .catch(() => 0);
  if (input.isJsonOutput) {
    printJson({
      status: "ok",
      isPresent: outcome.entries.length > 0,
      count: outcome.entries.length,
      invalidCount: outcome.invalidCount,
      pendingOutboxCount,
      entries: outcome.entries.map((entry) => ({
        fileName: entry.fileName,
        rejectionCode: entry.record.rejectionCode,
        rejectionReason: entry.record.rejectionReason,
        rejectedAtIso: entry.record.rejectedAtIso,
        messageId: entry.record.messageId,
        idempotencyKey: entry.record.idempotencyKey,
      })),
    });
    return EXIT_CODES.SUCCESS;
  }
  if (outcome.entries.length === 0) {
    process.stdout.write(
      `没有死信（永久性拒绝的消息不会进入补送队列；空 ≠ 从未发生）。补送积压：${String(
        pendingOutboxCount,
      )} 条。\n`,
    );
    return EXIT_CODES.SUCCESS;
  }
  for (const entry of outcome.entries) {
    process.stdout.write(
      `${entry.fileName}\t${entry.record.rejectionCode}\t${entry.record.messageId}\t${entry.record.rejectedAtIso}\n`,
    );
  }
  process.stdout.write(`补送积压：${String(pendingOutboxCount)} 条。\n`);
  if (outcome.invalidCount > 0) {
    writeDiagnosticText(`另有 ${String(outcome.invalidCount)} 个死信文件不可读（未删除，需人工检查）。`);
  }
  return EXIT_CODES.SUCCESS;
}

export interface FeedbackOutboxRequeueCommandInput {
  readonly stateDirectory: string;
  readonly fileName: string;
  readonly isJsonOutput: boolean;
}

export async function executeFeedbackOutboxRequeueCommand(
  input: FeedbackOutboxRequeueCommandInput,
): Promise<number> {
  const store = new FeedbackDeadLetterStore({ baseDirectory: input.stateDirectory });
  const outcome = await store.requeue(input.fileName);
  if (outcome === "requeued" || outcome === "already-queued") {
    if (input.isJsonOutput) {
      printJson({ status: "ok", outcome, fileName: input.fileName });
    } else {
      process.stdout.write(
        outcome === "requeued"
          ? "已写回补送队列（下一次心跳重试；是否再次被拒由反馈进程判定）。\n"
          : "该消息已在补送队列中（未重复写入）。\n",
      );
    }
    return EXIT_CODES.SUCCESS;
  }
  if (outcome === "invalid") {
    writeDiagnosticText("文件名非法（只接受 64 位十六进制哈希 .json）：未做任何修改。");
    return EXIT_CODES.USAGE_ERROR;
  }
  writeDiagnosticText("找不到该死信（可能已被重放或清除）。");
  return EXIT_CODES.FAILURE;
}

export interface FeedbackOutboxRemoveCommandInput {
  readonly stateDirectory: string;
  readonly fileName: string;
  readonly isJsonOutput: boolean;
}

export async function executeFeedbackOutboxRemoveCommand(
  input: FeedbackOutboxRemoveCommandInput,
): Promise<number> {
  const store = new FeedbackDeadLetterStore({ baseDirectory: input.stateDirectory });
  const isRemoved = await store.remove(input.fileName);
  if (!isRemoved) {
    writeDiagnosticText("未能删除：文件名非法或死信不存在。");
    return EXIT_CODES.FAILURE;
  }
  if (input.isJsonOutput) {
    printJson({ status: "ok", outcome: "removed", fileName: input.fileName });
  } else {
    process.stdout.write("已清除该死信（不可恢复）。\n");
  }
  return EXIT_CODES.SUCCESS;
}
