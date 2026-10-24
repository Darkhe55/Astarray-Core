/**
 * COMM-01-03（2026-10-24）：**只读**协作状态查询（拓扑 + 投递状态）。
 *
 * 数据来源（全部只读）：
 * - `AgentCreationRegistry.listAllRecords()`：Agent 归属（谁创建了谁、是否已回收）；
 * - 收件箱文件：每条消息的真实状态；
 * - `buildCollaborationTopologyView()`：单一事实来源的拓扑判定（环、孤儿、可投递）。
 *
 * 纪律：
 * - 不写盘、不投递、不改归属；
 * - `failed` 映射为 `dropped`（如实表现"送不到"，不伪装成已投递）；
 * - 空状态时明确写"空 ≠ 没有 Agent/消息"，不伪造计数。
 */
import type { AgentCreationRegistry } from "./agent-parent-binding-store.js";
import { CollaborationInboxStore } from "./collaboration-inbox-store.js";
import {
  buildCollaborationTopologyView,
  type CollaborationAgentNode,
  type CollaborationDeliveryRecord,
  type CollaborationTopologyView,
} from "./collaboration-topology-view.js";

export interface CollaborationStatusSnapshot {
  readonly agents: ReadonlyArray<CollaborationAgentNode>;
  readonly deliveries: ReadonlyArray<CollaborationDeliveryRecord>;
  readonly view: CollaborationTopologyView;
  /** 实际读到的收件箱文件数（0 也如实报告）。 */
  readonly inboxFileCount: number;
  /** 无法读取的收件箱文件数（损坏不掩盖）。 */
  readonly invalidInboxCount: number;
  readonly notice: string;
}

function mapInboxState(state: string): CollaborationDeliveryRecord["state"] {
  switch (state) {
    case "received":
      return "pending";
    case "delivered":
    case "processed":
    case "completed":
      return "delivered";
    case "failed":
      return "dropped";
    default:
      return "dropped";
  }
}

export async function buildCollaborationStatusFromState(input: {
  readonly stateDirectory: string;
  readonly registry: AgentCreationRegistry;
  readonly inboxStore?: CollaborationInboxStore;
}): Promise<CollaborationStatusSnapshot> {
  const registryRecords = await input.registry.listAllRecords();
  const agents: CollaborationAgentNode[] = registryRecords.map((record) => ({
    agentInstanceIdentifier: record.agentInstanceId,
    uniqueParentAgentInstanceIdentifier: record.createdByAgentInstanceId,
    isActive: record.recycledAtIso === null,
  }));

  const store = input.inboxStore ?? new CollaborationInboxStore({ baseDirectory: input.stateDirectory });
  const inboxList = await store.listInboxes();

  const deliveries: CollaborationDeliveryRecord[] = [];
  let invalidInboxCount = 0;
  for (const inboxFile of inboxList.inboxes) {
    const readOutcome = await store.read(inboxFile.recipientAgentInstanceId);
    if (readOutcome.kind !== "valid") {
      invalidInboxCount += 1;
      continue;
    }
    for (const message of readOutcome.snapshot.messages) {
      deliveries.push({
        deliveryIdentifier: message.messageIdentifier,
        targetAgentInstanceIdentifier: message.recipientAgentInstanceId,
        originalSourceAgentInstanceIdentifier: message.originalSourceAgentInstanceId,
        isRelayedRequest: message.isRelayedRequest,
        state: mapInboxState(message.state),
      });
    }
  }

  const view = buildCollaborationTopologyView({ agents, deliveries });
  return {
    agents,
    deliveries,
    view,
    inboxFileCount: inboxList.inboxes.length,
    invalidInboxCount,
    notice:
      inboxList.inboxes.length === 0 && agents.length === 0
        ? "没有登记 Agent、也没有收件箱文件（空 ≠ 不存在，可能是尚未运行）。"
        : "只读视图：不投递、不改归属、不写盘。",
  };
}
