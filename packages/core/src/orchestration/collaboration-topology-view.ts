/**
 * COMM-01-03（2026-10-20 R111）：**只读拓扑与投递状态**契约。
 *
 * 卡内依据（`docs/tasks/COMM01_...` COMM-01-03）："接入共用 SDK/CLI/TUI/GUI 消息路径与
 * **只读拓扑/投递状态查询**"；COMM-01-02 的"唯一上级出口"已由 `routeCollaborationViaUniqueParent` 落地。
 *
 * 本模块只做**只读视图**（不投递、不改归属、不写盘）：
 * 1. **无上级 ⇒ 不可投递**（`isOrphaned`，不得猜一个上级）；
 * 2. **环 ⇒ 全部不可投递**（A→B→A 这类"互相上报"不得显示为可送达）；
 * 3. **目标未登记 ⇒ 记 `dropped` 并如实计数**（不静默丢弃，也不伪装成已投递）；
 * 4. **转达必须保留原来源**（`originalSourceAgentInstanceId` 缺失 ⇒ 该条标 `isTraceLost`）；
 * 5. 视图**只读**（`isWritable:false`）且只含标识，不含任何消息正文/路径。
 *
 * ## 边界
 * 不读库、不解析消息体：输入即已有 agent 归属与投递记录。
 */
/** 一个执行者的归属信息。 */
export interface CollaborationAgentNode {
  readonly agentInstanceIdentifier: string;
  /** 唯一直属上级；无上级时为 null（不得猜）。 */
  readonly uniqueParentAgentInstanceIdentifier: string | null;
  /** 是否仍处于可用状态（已撤销/停用的执行者不再接收）。 */
  readonly isActive: boolean;
}

/** 一条待投递/已投递记录（只读摘要）。 */
export interface CollaborationDeliveryRecord {
  readonly deliveryIdentifier: string;
  readonly targetAgentInstanceIdentifier: string;
  readonly originalSourceAgentInstanceIdentifier: string | null;
  readonly isRelayedRequest: boolean;
  readonly state: "pending" | "delivered" | "paused" | "dropped";
}

/** 只读视图。 */
export interface CollaborationTopologyView {
  readonly nodes: ReadonlyArray<{
    readonly agentInstanceIdentifier: string;
    readonly parentAgentInstanceIdentifier: string | null;
    readonly isOrphaned: boolean;
    readonly isInCycle: boolean;
    readonly isDeliverable: boolean;
  }>;
  readonly deliveries: ReadonlyArray<{
    readonly deliveryIdentifier: string;
    readonly targetAgentInstanceIdentifier: string;
    readonly relayRecipientAgentInstanceIdentifier: string | null;
    readonly state: CollaborationDeliveryRecord["state"];
    /** 转达请求缺少原来源 ⇒ 追溯链断了（如实标注）。 */
    readonly isTraceLost: boolean;
  }>;
  readonly hasCycle: boolean;
  readonly deliverableCount: number;
  readonly pausedCount: number;
  readonly droppedCount: number;
  readonly isWritable: false;
}

/** 构建只读拓扑与投递状态。 */
export function buildCollaborationTopologyView(input: {
  readonly agents: ReadonlyArray<CollaborationAgentNode>;
  readonly deliveries: ReadonlyArray<CollaborationDeliveryRecord>;
}): CollaborationTopologyView {
  const agentsByIdentifier = new Map(
    input.agents.map((agent) => [agent.agentInstanceIdentifier, agent]),
  );

  // 环检测：沿 uniqueParent 走，命中的节点标记 in-cycle
  const agentsInCycle = new Set<string>();
  for (const agent of input.agents) {
    const visited: string[] = [];
    let cursor: string | null = agent.agentInstanceIdentifier;
    while (cursor !== null) {
      if (visited.includes(cursor)) {
        // 从重复点开始都是环成员
        for (const cycleMember of visited.slice(visited.indexOf(cursor))) {
          agentsInCycle.add(cycleMember);
        }
        break;
      }
      visited.push(cursor);
      cursor = agentsByIdentifier.get(cursor)?.uniqueParentAgentInstanceIdentifier ?? null;
    }
  }

  const nodes = input.agents.map((agent) => {
    const parentIdentifier = agent.uniqueParentAgentInstanceIdentifier;
    const parent = parentIdentifier === null ? undefined : agentsByIdentifier.get(parentIdentifier);
    const isOrphaned = parentIdentifier === null || parent === undefined;
    const isInCycle = agentsInCycle.has(agent.agentInstanceIdentifier);
    const isParentUsable = parent !== undefined && parent.isActive;
    return {
      agentInstanceIdentifier: agent.agentInstanceIdentifier,
      parentAgentInstanceIdentifier: parentIdentifier,
      isOrphaned,
      isInCycle,
      // 只有：自己在环外、有可用上级、且自己处于可用状态 ⇒ 可投递
      isDeliverable: !isOrphaned && !isInCycle && isParentUsable && agent.isActive,
    };
  });
  const nodeByIdentifier = new Map(nodes.map((node) => [node.agentInstanceIdentifier, node]));

  const deliveries = input.deliveries.map((delivery) => {
    const targetNode = nodeByIdentifier.get(delivery.targetAgentInstanceIdentifier);
    return {
      deliveryIdentifier: delivery.deliveryIdentifier,
      targetAgentInstanceIdentifier: delivery.targetAgentInstanceIdentifier,
      // 转达收件人 = 目标的唯一直属上级；目标不存在或不可投递则为 null（不猜）
      relayRecipientAgentInstanceIdentifier:
        targetNode !== undefined && targetNode.isDeliverable
          ? targetNode.parentAgentInstanceIdentifier
          : null,
      state: delivery.state,
      isTraceLost: delivery.isRelayedRequest && delivery.originalSourceAgentInstanceIdentifier === null,
    };
  });

  return {
    nodes,
    deliveries,
    hasCycle: agentsInCycle.size > 0,
    deliverableCount: nodes.filter((node) => node.isDeliverable).length,
    pausedCount: deliveries.filter((delivery) => delivery.state === "paused").length,
    droppedCount: deliveries.filter((delivery) => delivery.state === "dropped").length,
    isWritable: false,
  };
}
