/**
 * 独立反馈进程的 IPC 协议（T04）。
 * 显式版本化协议，业务消息不经过 stdout（stdout/stderr 只作诊断日志）。
 * 所有消息必须携带 protocolVersion 与 requestId（指令类）。
 */
import type { AgentStatus, FeedbackMessage, TransportHealth } from "../core/types.js";

/**
 * 入队拒绝原因（2026-11-21）：父进程按它区分永久/暂时。
 *
 * - `invalid-message`：schema/构造非法 ⇒ **永久**，重试同样的内容永远不会通过；
 * - `source-not-registered`：来源身份未登记 ⇒ **永久**（旧消息不因事后登记自动获得合法性；
 *   需要时由人从死信重放，而不是无限重试）；
 * - `journal-unavailable`：进程未就绪/journal 不可用 ⇒ **暂时**，保留补送继续退避。
 */
export type FeedbackEnqueueRejectionCode =
  | "invalid-message"
  | "source-not-registered"
  | "journal-unavailable";
import { FEEDBACK_PROTOCOL_VERSION } from "../core/types.js";

export type FeedbackIpcMessage =
  | {
      type: "hello";
      protocolVersion: number;
      baseDirectory: string;
      heartbeatTimeoutMilliseconds: number;
    }
  | {
      type: "enqueue";
      requestId: string;
      message: FeedbackMessage;
    }
  | {
      type: "setAgentStatus";
      recipientId: string;
      status: AgentStatus;
    }
  | {
      type: "ackDelivered";
      requestId: string;
      messageId: string;
    }
  | {
      type: "health";
      requestId: string;
    }
  | {
      type: "replay";
      requestId: string;
      recipientId: string;
    }
  | {
      type: "shutdown";
      requestId: string;
    }
  | {
      type: "heartbeat";
      timestampUnixMilliseconds: number;
    }
  | {
      type: "ready";
      protocolVersion: number;
      processPid: number;
    }
  | {
      type: "enqueued";
      requestId: string;
      accepted: boolean;
      /**
       * 2026-11-21（用户裁决 C）：拒绝时回传**可分类的原因**，父进程据此区分
       * "永久性拒绝"（进死信，不再重试）与"暂时不可用"（保留补送、继续退避）。
       */
      rejectionCode?: FeedbackEnqueueRejectionCode;
      rejectionReason?: string;
    }
  | {
      type: "deliver";
      message: FeedbackMessage;
    }
  | {
      type: "acked";
      requestId: string;
    }
  | {
      type: "healthResult";
      requestId: string;
      health: TransportHealth;
    }
  | {
      type: "replayResult";
      requestId: string;
      replayCount: number;
    }
  | {
      type: "shutdownComplete";
      requestId: string;
    }
  | {
      type: "selfTermination";
      /** 子进程自报的退出原因（退出前通过 IPC 发送）。 */
      reason: "heartbeat-lost" | "parent-disconnected";
    }
  | {
      type: "protocolError";
      requestId: string | null;
      errorCode: string;
      errorMessage: string;
    };

export { FEEDBACK_PROTOCOL_VERSION };

export function isProtocolVersionSupported(
  actualVersion: number,
): boolean {
  return actualVersion === FEEDBACK_PROTOCOL_VERSION;
}