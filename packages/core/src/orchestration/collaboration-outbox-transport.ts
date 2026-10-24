/**
 * COMM-01-02（2026-10-24）：**本地文件队列**投递适配器（用户允许新增 `inbox deliver`）。
 *
 * 用途：在没有真实 IPC 的开发/演示环境里，端到端验证投递语义：
 * - 写入 `<base>/collaboration/outbox/<recipient>/<messageIdentifier>.json`（原子写）；
 * - 同一 `messageIdentifier` 重复发送 ⇒ 不产生第二份（幂等）；
 * - 写入成功 = `delivered`（交给下游消费者读取后删除）。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";
import type { CollaborationInboxMessage } from "./collaboration-inbox.js";
import type { CollaborationInboxTransportPort } from "./collaboration-inbox-delivery.js";

export const COLLABORATION_OUTBOX_SCHEMA_VERSION = 1;

function sanitize(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized === "" ? "_empty" : sanitized;
}

export class CollaborationOutboxTransport implements CollaborationInboxTransportPort {
  private readonly baseDirectory: string;

  constructor(input: { readonly baseDirectory: string }) {
    this.baseDirectory = input.baseDirectory;
  }

  /** 收件人目录（测试与排查用）。 */
  directoryFor(recipientAgentInstanceId: string): string {
    return path.join(
      this.baseDirectory,
      "collaboration",
      "outbox",
      sanitize(recipientAgentInstanceId),
    );
  }

  /** 单条消息的队列文件路径。 */
  pathFor(recipientAgentInstanceId: string, messageIdentifier: string): string {
    return path.join(this.directoryFor(recipientAgentInstanceId), `${sanitize(messageIdentifier)}.json`);
  }

  async send(message: CollaborationInboxMessage): Promise<{
    readonly isDelivered: boolean;
    readonly reason?: string;
  }> {
    const filePath = this.pathFor(message.recipientAgentInstanceId, message.messageIdentifier);
    if (existsSync(filePath)) {
      return { isDelivered: true, reason: "队列中已存在同一消息（幂等：不重复写入）。" };
    }
    await writeAtomicJson(filePath, {
      schemaVersion: COLLABORATION_OUTBOX_SCHEMA_VERSION,
      messageIdentifier: message.messageIdentifier,
      correlationIdentifier: message.correlationIdentifier,
      recipientAgentInstanceId: message.recipientAgentInstanceId,
      senderAgentInstanceId: message.senderAgentInstanceId,
      taskIdentifier: message.taskIdentifier,
      summary: message.summary,
      authorizationEpoch: message.authorizationEpoch,
      enqueuedAtIso: message.receivedAtIso,
    });
    return { isDelivered: true, reason: "已写入本地 outbox（读取方负责消费）。" };
  }
}
