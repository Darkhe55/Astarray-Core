/**
 * COMM-01-02 §2.4 反例（2026-10-23）：转达跳数上限与关联链循环检测。
 *
 * 卡内：有限重试、**转发跳数**与**关联链循环检测**；超过上限不得无限转发，应升级用户。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_COLLABORATION_MAXIMUM_HOPS,
  evaluateCollaborationRelayChain,
} from "../../../packages/core/src/orchestration/collaboration-relay-chain.js";

describe("COMM-01-02 转达跳数与环检测", () => {
  it("① 首跳（hopCount=0，上限 1）⇒ 允许，nextHopCount=1", () => {
    const verdict = evaluateCollaborationRelayChain({
      originalSourceAgentInstanceId: "agent-a",
      targetAgentInstanceId: "agent-b",
    });
    expect(verdict).toMatchObject({ isAllowed: true, nextHopCount: 1 });
  });

  it("② 已达上限（hopCount=1）⇒ 拒绝并升级用户（不无限转发）", () => {
    const verdict = evaluateCollaborationRelayChain({
      originalSourceAgentInstanceId: "agent-a",
      targetAgentInstanceId: "agent-b",
      relayChain: { hopCount: 1 },
    });
    expect(verdict).toMatchObject({
      isAllowed: false,
      reasonCode: "hop-limit-exceeded",
      shouldEscalateToUser: true,
    });
    expect(verdict.isAllowed === false ? verdict.reason : "").toContain("上限");
    expect(DEFAULT_COLLABORATION_MAXIMUM_HOPS).toBe(1);
  });

  it("③ 环：目标已在 visited 里（A→B→A）⇒ 拒绝并升级用户", () => {
    const verdict = evaluateCollaborationRelayChain({
      originalSourceAgentInstanceId: "agent-a",
      targetAgentInstanceId: "agent-a-requester",
      relayChain: {
        hopCount: 0,
        visitedAgentInstanceIds: ["agent-x", "agent-a-requester"],
      },
    });
    expect(verdict).toMatchObject({ isAllowed: false, reasonCode: "relay-cycle-detected" });
    expect(verdict.isAllowed === false ? verdict.reason : "").toContain("成环");
  });

  it("④ 自我转达（目标====发起者）⇒ 拒绝，但**不**升级用户（这是调用错误）", () => {
    const verdict = evaluateCollaborationRelayChain({
      originalSourceAgentInstanceId: "agent-a",
      targetAgentInstanceId: "agent-a",
    });
    expect(verdict).toMatchObject({ isAllowed: false, reasonCode: "self-relay", shouldEscalateToUser: false });
  });

  it("⑤ 显式放宽上限（maximumHops=3）⇒ 第 2 跳仍允许", () => {
    const verdict = evaluateCollaborationRelayChain({
      originalSourceAgentInstanceId: "agent-a",
      targetAgentInstanceId: "agent-b",
      relayChain: { hopCount: 1, maximumHops: 3 },
    });
    expect(verdict).toMatchObject({ isAllowed: true, nextHopCount: 2 });
  });

  it("⑥ 环检测优先于跳数：即使 hopCount 未超限，成环也先拒", () => {
    const verdict = evaluateCollaborationRelayChain({
      originalSourceAgentInstanceId: "agent-a",
      targetAgentInstanceId: "agent-b",
      relayChain: { hopCount: 0, maximumHops: 5, visitedAgentInstanceIds: ["agent-b"] },
    });
    expect(verdict).toMatchObject({ isAllowed: false, reasonCode: "relay-cycle-detected" });
  });
});
