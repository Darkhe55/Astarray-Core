/**
 * R147（2026-11-03）：从主 Agent 输出提取提案 JSON 的纯函数单测。
 */
import { describe, expect, it } from "vitest";

import { extractMainAgentProposalPayload } from "../../packages/core/src/orchestration/main-agent-proposal-autosubmit.js";

const proposal = {
  targetSecondaryAgentInstanceIdentifier: "scheduler:mission-1",
  sequenceIdentifier: "sequence-1",
  expectedRevision: 0,
  title: "补文档",
  userTaskReference: "user-message-1",
  predecessorTaskIdentifiers: [],
  successorTaskIdentifiers: [],
  priorityTier: 0,
  requiredArtifactIdentifiers: [],
  acceptanceCriteria: "完成",
};

describe("extractMainAgentProposalPayload", () => {
  it("整段 JSON 提案 ⇒ 返回对象", () => {
    expect(extractMainAgentProposalPayload(JSON.stringify(proposal))).toEqual(proposal);
  });

  it("```json 围栏 ⇒ 去掉围栏后解析", () => {
    const text = "```json\n" + JSON.stringify(proposal) + "\n```";
    expect(extractMainAgentProposalPayload(text)).toEqual(proposal);
  });

  it("普通回答 / 非 JSON ⇒ null", () => {
    expect(extractMainAgentProposalPayload("你好，我来回答。")).toBeNull();
    expect(extractMainAgentProposalPayload("{ 不是 JSON")).toBeNull();
  });

  it("JSON 但不是提案（缺目标个体）⇒ null", () => {
    expect(extractMainAgentProposalPayload('{"title":"x"}')).toBeNull();
  });

  it("数组 / null ⇒ null", () => {
    expect(extractMainAgentProposalPayload("[]")).toBeNull();
    expect(extractMainAgentProposalPayload("null")).toBeNull();
  });
});
