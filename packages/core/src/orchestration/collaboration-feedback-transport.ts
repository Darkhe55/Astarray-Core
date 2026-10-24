/**
 * COMM-01-02（2026-10-24）：把协作收件箱接到**独立反馈进程**。
 *
 * 投递语义（如实）：`enqueue` 成功 = 消息已进入反馈进程的**持久化队列**，
 * 由反馈进程负责后续投递与 ack；这里不代表收件人已处理。
 *
 * 失败语义：`enqueue` 抛错（进程未启动/协议不兼容）⇒ 本次不算投递，
 * 由收件箱的有限重试接管（不静默标 delivered）。
 */
import type { AgentRole, FeedbackTransportPort } from "../core/types.js";
import type {
  CollaborationInboxMessage,
} from "./collaboration-inbox.js";
import type { CollaborationInboxTransportPort } from "./collaboration-inbox-delivery.js";
import { buildCollaborationFeedbackMessage } from "./collaboration-feedback-mapping.js";

export class CollaborationFeedbackTransport implements CollaborationInboxTransportPort {
  private readonly feedbackTransport: FeedbackTransportPort;
  private readonly sourceAgentRole: AgentRole;
  private readonly protocolVersion: number | undefined;

  constructor(input: {
    readonly feedbackTransport: FeedbackTransportPort;
    readonly sourceAgentRole: AgentRole;
    readonly protocolVersion?: number;
  }) {
    this.feedbackTransport = input.feedbackTransport;
    this.sourceAgentRole = input.sourceAgentRole;
    this.protocolVersion = input.protocolVersion;
  }

  async send(message: CollaborationInboxMessage): Promise<{
    readonly isDelivered: boolean;
    readonly reason?: string;
  }> {
    const feedbackMessage = buildCollaborationFeedbackMessage({
      message,
      sourceAgentRole: this.sourceAgentRole,
      ...(this.protocolVersion === undefined ? {} : { protocolVersion: this.protocolVersion }),
    });
    try {
      await this.feedbackTransport.enqueue(feedbackMessage);
      return {
        isDelivered: true,
        reason: "已入队到独立反馈进程（入队 ≠ 收件人已处理）。",
      };
    } catch (error) {
      return {
        isDelivered: false,
        reason:
          "反馈进程不可用：" +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  }
}
