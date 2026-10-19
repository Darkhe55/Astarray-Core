/**
 * COMM-01-03 只读拓扑视图的反例（2026-10-20 R111）。
 */
import { describe, expect, it } from "vitest";

import {
  buildCollaborationTopologyView,
  type CollaborationAgentNode,
  type CollaborationDeliveryRecord,
} from "../../../packages/core/src/orchestration/collaboration-topology-view.js";

function agent(
  identifier: string,
  parent: string | null,
  isActive = true,
): CollaborationAgentNode {
  return {
    agentInstanceIdentifier: identifier,
    uniqueParentAgentInstanceIdentifier: parent,
    isActive,
  };
}

function delivery(
  overrides: Partial<CollaborationDeliveryRecord> = {},
): CollaborationDeliveryRecord {
  return {
    deliveryIdentifier: "delivery-1",
    targetAgentInstanceIdentifier: "worker-1",
    originalSourceAgentInstanceIdentifier: "worker-2",
    isRelayedRequest: true,
    state: "pending",
    ...overrides,
  };
}

describe("协作拓扑只读视图", () => {
  it("① 有可用上级 ⇒ 可投递，且转达收件人就是唯一直属上级", () => {
    const view = buildCollaborationTopologyView({
      agents: [agent("parent-1", null), agent("worker-1", "parent-1")],
      deliveries: [delivery()],
    });
    const workerNode = view.nodes.find((node) => node.agentInstanceIdentifier === "worker-1");
    expect(workerNode?.isDeliverable).toBe(true);
    expect(view.deliveries[0]?.relayRecipientAgentInstanceIdentifier).toBe("parent-1");
    expect(view.isWritable).toBe(false);
  });

  it("② 无上级 ⇒ 孤立且不可投递（不得猜上级），转达收件人为 null", () => {
    const view = buildCollaborationTopologyView({
      agents: [agent("worker-1", null)],
      deliveries: [delivery()],
    });
    expect(view.nodes[0]).toMatchObject({ isOrphaned: true, isDeliverable: false });
    expect(view.deliveries[0]?.relayRecipientAgentInstanceIdentifier).toBeNull();
  });

  it("③ 上级已停用 ⇒ 不可投递", () => {
    const view = buildCollaborationTopologyView({
      agents: [agent("parent-1", null, false), agent("worker-1", "parent-1")],
      deliveries: [delivery()],
    });
    const workerNode = view.nodes.find((node) => node.agentInstanceIdentifier === "worker-1");
    expect(workerNode?.isDeliverable).toBe(false);
    expect(view.deliveries[0]?.relayRecipientAgentInstanceIdentifier).toBeNull();
  });

  it("④ A→B→A 形成环 ⇒ 环内全部不可投递且 hasCycle 为真（不得互相当上级）", () => {
    const view = buildCollaborationTopologyView({
      agents: [agent("worker-1", "worker-2"), agent("worker-2", "worker-1")],
      deliveries: [delivery()],
    });
    expect(view.hasCycle).toBe(true);
    expect(view.nodes.every((node) => node.isInCycle)).toBe(true);
    expect(view.nodes.every((node) => node.isDeliverable)).toBe(false);
    expect(view.deliverableCount).toBe(0);
  });

  it("⑤ 目标未登记 ⇒ 不投递并计为 dropped（如实计数，不伪装成已投递）", () => {
    const view = buildCollaborationTopologyView({
      agents: [agent("parent-1", null)],
      deliveries: [
        delivery({
          deliveryIdentifier: "delivery-unknown-target",
          targetAgentInstanceIdentifier: "ghost",
          state: "dropped",
        }),
      ],
    });
    expect(view.droppedCount).toBe(1);
    expect(view.deliveries[0]?.relayRecipientAgentInstanceIdentifier).toBeNull();
  });

  it("⑥ 转达请求缺原来源 ⇒ 标记 isTraceLost（追溯链断了不隐藏）", () => {
    const view = buildCollaborationTopologyView({
      agents: [agent("parent-1", null), agent("worker-1", "parent-1")],
      deliveries: [
        delivery({ deliveryIdentifier: "delivery-lost", originalSourceAgentInstanceIdentifier: null }),
        delivery({ deliveryIdentifier: "delivery-ok" }),
      ],
    });
    const lost = view.deliveries.find((item) => item.deliveryIdentifier === "delivery-lost");
    const ok = view.deliveries.find((item) => item.deliveryIdentifier === "delivery-ok");
    expect(lost?.isTraceLost).toBe(true);
    expect(ok?.isTraceLost).toBe(false);
  });

  it("⑦ 暂停投递单独计数；视图只含标识（无消息正文/路径）", () => {
    const view = buildCollaborationTopologyView({
      agents: [agent("parent-1", null), agent("worker-1", "parent-1")],
      deliveries: [
        delivery({ deliveryIdentifier: "delivery-paused", state: "paused" }),
        delivery({ deliveryIdentifier: "delivery-pending", state: "pending" }),
      ],
    });
    expect(view.pausedCount).toBe(1);
    const serializedView = JSON.stringify(view);
    // 只读视图不得携带任何正文类字段名
    expect(serializedView).not.toContain("messageText");
    expect(serializedView).not.toContain("body");
    expect(serializedView).not.toContain("path");
  });
});
