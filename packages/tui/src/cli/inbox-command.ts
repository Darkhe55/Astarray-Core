/**
 * COMM-01-02（2026-10-24）：`inbox list` 只读 CLI。
 *
 * 纪律：
 * - 只读（不写收件箱、不投递、不调模型）；
 * - 未保存过 ⇒ 明确写"收件箱不存在（尚未接收消息；空 ≠ 无消息）"，不伪造空列表；
 * - 损坏文件 ⇒ 退出码 2 并给原因，不静默当空。
 */
import { CollaborationInboxStore } from "../../../core/src/orchestration/collaboration-inbox-store.js";
import { EXIT_CODES, printJson } from "./json-output.js";

export interface InboxListCommandInput {
  readonly stateDirectory: string;
  readonly recipientAgentInstanceId: string;
  /** 可选状态过滤（received/delivered/processed/completed/failed）。 */
  readonly stateFilter: string | null;
  readonly isJsonOutput: boolean;
}

export async function executeInboxListCommand(input: InboxListCommandInput): Promise<number> {
  const store = new CollaborationInboxStore({ baseDirectory: input.stateDirectory });
  const outcome = await store.read(input.recipientAgentInstanceId);

  if (outcome.kind === "invalid") {
    process.stderr.write("收件箱不可读（未静默当空）：" + outcome.reason + "\n");
    return 2;
  }
  if (outcome.kind === "absent") {
    const text = "收件箱不存在（尚未接收消息；空 ≠ 无消息）。";
    if (input.isJsonOutput) {
      printJson({
        status: "ok",
        recipientAgentInstanceId: input.recipientAgentInstanceId,
        isPresent: false,
        revision: null,
        messages: [],
        notice: text,
      });
    } else {
      process.stdout.write(text + "\n");
    }
    return EXIT_CODES.SUCCESS;
  }

  const snapshot = outcome.snapshot;
  const messages =
    input.stateFilter === null
      ? snapshot.messages
      : snapshot.messages.filter((message) => message.state === input.stateFilter);

  if (input.isJsonOutput) {
    printJson({
      status: "ok",
      recipientAgentInstanceId: input.recipientAgentInstanceId,
      isPresent: true,
      revision: snapshot.revision,
      updatedAtIso: snapshot.updatedAtIso,
      messages,
    });
    return EXIT_CODES.SUCCESS;
  }

  if (messages.length === 0) {
    process.stdout.write(
      "收件箱为空（revision " + String(snapshot.revision) + "；空 ≠ 无消息，可能是过滤条件所致）。\n",
    );
    return EXIT_CODES.SUCCESS;
  }
  for (const message of messages) {
    process.stdout.write(
      [
        message.messageIdentifier,
        message.state,
        "task=" + message.taskIdentifier,
        "corr=" + message.correlationIdentifier,
        "attempts=" + String(message.deliveryAttemptCount),
        message.duplicateDeliveryCount > 0 ? "duplicates=" + String(message.duplicateDeliveryCount) : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ") + "\n",
    );
  }
  return EXIT_CODES.SUCCESS;
}
