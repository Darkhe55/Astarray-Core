/**
 * COMM-01-02（2026-10-24，用户批准的协议扩展 a + 收件人前缀 b）：
 * 协作消息 ↔ 反馈协议消息的映射。
 *
 * 映射约定：
 * - **收件人标识**：`agent:<agentInstanceId>`（前缀避免与其它信箱命名冲突）；
 * - **idempotencyKey** = `messageIdentifier`（重复投递由反馈进程去重）；
 * - **优先级** = `instruction`（协作请求是要对方行动，最高优先级；worker 侧同样映射）；
 * - **payload.kind** = `collaboration-request`（不是 success/failure 文本通道）。
 *
 * 注意：`enqueue` 成功 = **已入队到独立反馈进程的持久化队列**，
 * 不等于收件人已处理（收件箱的 delivered / processed / completed 仍分开）。
 */
import type {
  AgentRole,
  FeedbackMessage,
  FeedbackMessagePayload,
} from "../core/types.js";
import { createHash } from "node:crypto";
import { FEEDBACK_PROTOCOL_VERSION } from "../core/types.js";
import type { CollaborationInboxMessage } from "./collaboration-inbox.js";
import { carriedAuthorizationIdentifier } from "./collaboration-authorization-stamping.js";

/** 收件人前缀（用户 2026-10-24 决定 b）。 */
export const COLLABORATION_RECIPIENT_PREFIX = "agent:";

/**
 * 协作标识 ⇒ 反馈协议 `messageId`（2026-11-21）。
 *
 * 协议要求 `messageId` 是 UUID，而协作标识是任意字符串（`"collaboration:<id>"` 形式
 * 会被 `feedbackMessageSchema` 直接判非法 ⇒ 反馈进程逐条拒绝）。这里从协作标识
 * **确定性派生** UUID v5 形状：重试得到同一 messageId（重放去重仍成立），
 * 不同标识得到不同 messageId（不会串消息）；原始协作标识仍保留在
 * `payload.messageIdentifier`（回复路由用这个，不用 messageId）。
 */
function collaborationMessageIdUuid(messageIdentifier: string): string {
  const digest = createHash("sha1")
    .update("collaboration:" + messageIdentifier)
    .digest("hex");
  const variant = ((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, "0");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    "5" + digest.slice(13, 16),
    variant + digest.slice(18, 20),
    digest.slice(20, 32),
  ].join("-");
}

/** `agentInstanceId` ⇒ 反馈协议里的 recipientId。 */
export function toCollaborationRecipientId(agentInstanceId: string): string {
  return COLLABORATION_RECIPIENT_PREFIX + agentInstanceId;
}

/** recipientId ⇒ `agentInstanceId`；不是协作前缀时返回 null（不猜）。 */
export function fromCollaborationRecipientId(recipientId: string): string | null {
  if (!recipientId.startsWith(COLLABORATION_RECIPIENT_PREFIX)) return null;
  const agentInstanceId = recipientId.slice(COLLABORATION_RECIPIENT_PREFIX.length);
  return agentInstanceId === "" ? null : agentInstanceId;
}

/** 构造反馈协议消息（纯函数）。 */
export function buildCollaborationFeedbackMessage(input: {
  readonly message: CollaborationInboxMessage;
  /** 发送者的 Agent 层级（不猜：必须显式给出）。 */
  readonly sourceAgentRole: AgentRole;
  readonly protocolVersion?: number;
}): FeedbackMessage {
  /**
   * COORD-02 §7「生产与传输」：**关系标识**随反馈映射原样传递。
   *
   * 只带代际时接收侧无法回权威存储复核（`authorization-missing`）；缺省即不写，
   * 不补默认值、不把空串当章。
   */
  const authorizationIdentifier = carriedAuthorizationIdentifier(
    input.message.authorizationIdentifier,
  );
  const payload: FeedbackMessagePayload = {
    kind: "collaboration-request",
    messageIdentifier: input.message.messageIdentifier,
    correlationIdentifier: input.message.correlationIdentifier,
    taskIdentifier: input.message.taskIdentifier,
    /** COMM-01-02 修正：把原任务产物引用带到反馈载荷（接收方据此核对依据）。 */
    ...(input.message.artifactReferences === undefined
      ? {}
      : {
          artifactReferences: input.message.artifactReferences.map((reference) => ({
            artifactIdentifier: reference.artifactIdentifier,
            revision: reference.revision,
          })),
        }),
    /** 未填产物时把"没有产物相关信息"显式送达接收方。 */
    artifactReferenceStatus: input.message.artifactReferenceStatus,
    summary: input.message.summary,
    authorizationEpoch: input.message.authorizationEpoch,
    hopCount: 0,
  };
  return {
    protocolVersion: input.protocolVersion ?? FEEDBACK_PROTOCOL_VERSION,
    messageId: collaborationMessageIdUuid(input.message.messageIdentifier),
    /** COORD-01-02：把任务归属带到**信封**（不再只放在 payload 里）。 */
    taskIdentifier: input.message.taskIdentifier,
    /**
     * COMM-01（2026-11-15 用户裁决第 1 条）：把 **mission 与回复指向**带到信封。
     *
     * 缺这两项时，接收方回复会因"无法定位任务链/无法证明原路径"被拒绝——
     * 也就是说：不在这里标记，规则就无法实际使用（不是可选优化）。
     */
    ...(input.message.missionIdentifier === undefined || input.message.missionIdentifier === null
      ? {}
      : { missionIdentifier: input.message.missionIdentifier }),
    ...(input.message.replyToMessageIdentifier === undefined ||
    input.message.replyToMessageIdentifier === null
      ? {}
      : { replyToMessageIdentifier: input.message.replyToMessageIdentifier }),
    ...(authorizationIdentifier === undefined ? {} : { authorizationIdentifier }),
    source: {
      sourceType: "agent",
      agentInstanceId: input.message.senderAgentInstanceId,
      agentRole: input.sourceAgentRole,
    },
    recipientId: toCollaborationRecipientId(input.message.recipientAgentInstanceId),
    priority: "instruction",
    createdAtIso: input.message.receivedAtIso,
    idempotencyKey: input.message.messageIdentifier,
    payload,
  };
}
