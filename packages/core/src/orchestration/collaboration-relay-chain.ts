/**
 * COMM-01-02 §2.4（2026-10-23）：协作转达的**跳数上限**与**关联链循环检测**。
 *
 * 卡内要求：
 * - "每收件人背压、有限重试、**转发跳数**和**关联链循环检测**复用现有机制"；
 * - 三级/四级跨上级协商**由唯一直属上级代理转达**，执行者只认识一个上级。
 *
 * 现有 `evaluatePeerRelay`（secretary-relay-contract）已实现"同级转达有界 + 升级用户"；
 * 本文件把它接到 `routeCollaborationViaUniqueParent` 的判定链上，并补**循环检测**：
 * 若转达链上已经出现过目标，再转达就是环（A→B→A），必须拒绝而不是无限转发。
 */
import {
  evaluatePeerRelay,
} from "./secretary-relay-contract.js";

/** 转达链信息（调用方随消息带上；缺省按"首跳"处理）。 */
export interface CollaborationRelayChain {
  /** 已经过的转达跳数（首次发起为 0）。 */
  readonly hopCount?: number;
  /** 已经过的 agentInstanceId（按先后顺序；用于环检测）。 */
  readonly visitedAgentInstanceIds?: ReadonlyArray<string>;
  /** 允许的最大跳数（缺省 1：同级之间最多一次，与卡片建议一致）。 */
  readonly maximumHops?: number;
}

export const DEFAULT_COLLABORATION_MAXIMUM_HOPS = 1;

export type CollaborationRelayChainVerdict =
  | {
      readonly isAllowed: true;
      readonly nextHopCount: number;
      readonly reason: string;
    }
  | {
      readonly isAllowed: false;
      readonly reasonCode: "hop-limit-exceeded" | "relay-cycle-detected" | "self-relay";
      readonly reason: string;
      readonly shouldEscalateToUser: boolean;
    };

/**
 * 判定一次转达是否还可以继续。
 *
 * 顺序是刻意的：
 * 1. **自我转达**（目标====发起者）⇒ 拒绝；
 * 2. **环检测**（目标已在 visited 里）⇒ 拒绝并升级用户；
 * 3. **跳数上限**（复用 `evaluatePeerRelay`）⇒ 超限拒绝并升级用户。
 */
export function evaluateCollaborationRelayChain(input: {
  readonly originalSourceAgentInstanceId: string;
  readonly targetAgentInstanceId: string;
  readonly relayChain?: CollaborationRelayChain;
}): CollaborationRelayChainVerdict {
  if (input.targetAgentInstanceId === input.originalSourceAgentInstanceId) {
    return {
      isAllowed: false,
      reasonCode: "self-relay",
      reason: "协作目标与发起者是同一主体：不得借「自我协作」绕开唯一上级路由。",
      shouldEscalateToUser: false,
    };
  }

  const visited = input.relayChain?.visitedAgentInstanceIds ?? [];
  if (visited.includes(input.targetAgentInstanceId)) {
    return {
      isAllowed: false,
      reasonCode: "relay-cycle-detected",
      reason:
        "关联链上已出现过目标 `" +
        input.targetAgentInstanceId +
        "`（转达成环）⇒ 停止转发并升级用户裁决。",
      shouldEscalateToUser: true,
    };
  }

  const peerRelay = evaluatePeerRelay({
    hopCount: input.relayChain?.hopCount ?? 0,
    maximumHops: input.relayChain?.maximumHops ?? DEFAULT_COLLABORATION_MAXIMUM_HOPS,
  });
  if (!peerRelay.isAllowed) {
    return {
      isAllowed: false,
      reasonCode: "hop-limit-exceeded",
      reason: peerRelay.reason,
      shouldEscalateToUser: peerRelay.shouldEscalateToUser,
    };
  }
  return {
    isAllowed: true,
    nextHopCount: peerRelay.nextHopCount,
    reason: peerRelay.reason,
  };
}

