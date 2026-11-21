/**
 * 2026-11-21（用户裁决）：`collaboration send` —— 协作请求的人工生产入口。
 *
 * 与 SDK 门面共用 `sendCollaborationRequest`：地址完整性、层级转达、授权章、
 * 入箱持久化、投递全部同一实现；CLI 只负责参数与输出。
 */
import type { AgentRole } from "../../../core/src/core/types.js";
import { CollaborationInboxStore } from "../../../core/src/orchestration/collaboration-inbox-store.js";
import { CollaborationOutboxTransport } from "../../../core/src/orchestration/collaboration-outbox-transport.js";
import { CrossProjectAuthorizationStore } from "../../../core/src/orchestration/cross-project-authorization-store.js";
import { AgentCreationRegistry } from "../../../core/src/orchestration/agent-parent-binding-store.js";
import { sendCollaborationRequest } from "../../../core/src/orchestration/collaboration-request-service.js";
import { EXIT_CODES, printJson, writeDiagnosticText } from "./json-output.js";

export interface CollaborationSendCommandInput {
  readonly stateDirectory: string;
  readonly fromAgentInstanceId: string;
  readonly toAgentInstanceId: string;
  readonly taskIdentifier: string;
  readonly summary: string;
  readonly missionIdentifier: string | null;
  readonly replyToMessageIdentifier: string | null;
  readonly requestIdentifier: string | null;
  readonly senderRole: AgentRole | null;
  readonly projectScope: "same-project" | "cross-project";
  readonly authorizationIdentifier: string | null;
  readonly sourceProjectIdentifier: string | null;
  readonly targetProjectIdentifier: string | null;
  readonly isJsonOutput: boolean;
}

export async function executeCollaborationSendCommand(
  input: CollaborationSendCommandInput,
): Promise<number> {
  const registry = new AgentCreationRegistry({ stateDirectory: input.stateDirectory });
  const outcome = await sendCollaborationRequest(
    {
      inboxStore: new CollaborationInboxStore({ baseDirectory: input.stateDirectory }),
      authorizationStore: new CrossProjectAuthorizationStore({
        baseDirectory: input.stateDirectory,
      }),
      transport: new CollaborationOutboxTransport({ baseDirectory: input.stateDirectory }),
      isRecipientKnown: async (agentInstanceId) => {
        const record = await registry.getRecord(agentInstanceId);
        return record !== null && record.recycledAtIso === null;
      },
      uniqueParentOf: async (agentInstanceId) => {
        const record = await registry.getRecord(agentInstanceId);
        return record?.createdByAgentInstanceId ?? null;
      },
    },
    {
      senderAgentInstanceId: input.fromAgentInstanceId,
      ...(input.senderRole === null ? {} : { senderRole: input.senderRole }),
      recipientAgentInstanceId: input.toAgentInstanceId,
      taskIdentifier: input.taskIdentifier,
      summary: input.summary,
      nowIso: new Date().toISOString(),
      projectScope: input.projectScope,
      ...(input.missionIdentifier === null ? {} : { missionIdentifier: input.missionIdentifier }),
      ...(input.replyToMessageIdentifier === null
        ? {}
        : { replyToMessageIdentifier: input.replyToMessageIdentifier }),
      ...(input.requestIdentifier === null ? {} : { requestIdentifier: input.requestIdentifier }),
      ...(input.authorizationIdentifier === null
        ? {}
        : { authorizationIdentifier: input.authorizationIdentifier }),
      ...(input.sourceProjectIdentifier === null
        ? {}
        : { sourceProjectIdentifier: input.sourceProjectIdentifier }),
      ...(input.targetProjectIdentifier === null
        ? {}
        : { targetProjectIdentifier: input.targetProjectIdentifier }),
    },
  );

  if (input.isJsonOutput) {
    printJson(outcome);
  } else if (outcome.kind === "refused") {
    writeDiagnosticText(`拒绝发送：${outcome.code} —— ${outcome.reason}`);
  } else {
    process.stdout.write(
      `${outcome.kind === "sent" ? "已发送" : "已存在（幂等）"}: ${outcome.messageIdentifier}\n` +
        `授权关系: ${outcome.authorizationIdentifier}（代 ${String(outcome.authorizationEpoch)}）\n` +
        `收件箱状态: ${outcome.inboxState}${outcome.isDelivered ? "（已投递）" : "（未投递）"}\n` +
        `${outcome.deliveryReason}\n`,
    );
  }
  return outcome.kind === "refused" ? EXIT_CODES.FAILURE : EXIT_CODES.SUCCESS;
}
