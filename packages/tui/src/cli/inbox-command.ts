/**
 * COMM-01-02（2026-10-24）：`inbox list` / `inbox deliver` CLI。
 *
 * 纪律：
 * - `list` 只读（不写收件箱、不投递、不调模型）；
 * - 未保存过 ⇒ 明确写"收件箱不存在（尚未接收消息；空 ≠ 无消息）"，不伪造空列表；
 * - 损坏文件 ⇒ 退出码 2 并给原因，不静默当空；
 * - `deliver` 只写入本地 outbox（入队 ≠ 收件人已处理），无收件箱/损坏/冲突同样退出码 2。
 */
import { CollaborationInboxStore } from "../../../core/src/orchestration/collaboration-inbox-store.js";
import { CollaborationInboxDeliveryService } from "../../../core/src/orchestration/collaboration-inbox-delivery.js";
import { CollaborationOutboxTransport } from "../../../core/src/orchestration/collaboration-outbox-transport.js";
import { EXIT_CODES, printJson } from "./json-output.js";

/** `inbox deliver` 退出码：收件箱不可用（不存在/损坏/冲突）。 */
const INBOX_UNAVAILABLE_EXIT_CODE = 2;
/** `inbox deliver` 退出码：投递失败（可重试或已耗尽）。 */
const INBOX_DELIVERY_FAILED_EXIT_CODE = 1;

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

/** `inbox deliver` 输入。 */
export interface InboxDeliverCommandInput {
  readonly stateDirectory: string;
  readonly recipientAgentInstanceId: string;
  /** 传输实现；目前只支持 file-outbox（本地队列）。 */
  readonly transportName: string;
  readonly isJsonOutput: boolean;
}

/**
 * `inbox deliver`：把某收件人的 pending 消息投递到本地 outbox。
 *
 * 退出码：0 = 已投递/无事可做；1 = 投递失败（可重试/已耗尽）；2 = 收件箱不可用。
 */
export async function executeInboxDeliverCommand(
  input: InboxDeliverCommandInput,
): Promise<number> {
  if (input.transportName !== "file-outbox") {
    process.stderr.write(
      "不支持的传输实现 `" + input.transportName + "`：目前只支持 file-outbox（本地队列）。\n",
    );
    return INBOX_UNAVAILABLE_EXIT_CODE;
  }
  const store = new CollaborationInboxStore({ baseDirectory: input.stateDirectory });
  const delivery = new CollaborationInboxDeliveryService({
    store,
    transport: new CollaborationOutboxTransport({ baseDirectory: input.stateDirectory }),
    options: { maximumPendingPerRecipient: 100, maximumDeliveryAttempts: 3 },
  });
  const report = await delivery.deliverPendingForRecipient({
    recipientAgentInstanceId: input.recipientAgentInstanceId,
    nowIso: new Date().toISOString(),
  });
  if (input.isJsonOutput) {
    printJson({ status: "ok", recipientAgentInstanceId: input.recipientAgentInstanceId, report });
  } else {
    process.stdout.write(report.reason + "\n");
  }
  if (
    report.outcome === "no-inbox" ||
    report.outcome === "invalid-inbox" ||
    report.outcome === "revision-conflict"
  ) {
    return INBOX_UNAVAILABLE_EXIT_CODE;
  }
  if (report.outcome === "failed") return INBOX_DELIVERY_FAILED_EXIT_CODE;
  return EXIT_CODES.SUCCESS;
}
