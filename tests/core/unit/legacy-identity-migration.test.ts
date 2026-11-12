/**
 * 旧身份迁移审计（此前 `tests/` 零引用）：**只读、不按名字猜、永不自动迁移**。
 *
 * 全部反例围绕"宁可保持独立也不猜归属"：
 * 声明不是证据；多会话引用 ⇒ 歧义保持独立；临时个体永不合并；未知一律计入 unknown。
 */
import { describe, expect, it } from "vitest";

import {
  LEGACY_IDENTITY_MIGRATION_RULES_VERSION,
  analyzeLegacyIdentityAssociations,
  isEphemeralLegacyAgentIdentifier,
} from "../../../packages/core/src/orchestration/legacy-identity-migration.js";
import type { LegacyIdentitySnapshot } from "../../../packages/core/src/orchestration/legacy-identity-migration.js";

function buildSnapshot(overrides: Partial<LegacyIdentitySnapshot> = {}): LegacyIdentitySnapshot {
  return { conversations: [], missions: [], agentMemoryIdentifiers: [], ...overrides };
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    conversationIdentifier: "conversation-1",
    projectIdentifier: "project-alpha",
    mainAgentInstanceIdentifier: "main-agent-1",
    runs: [],
    ...overrides,
  } as never;
}

describe("临时个体识别", () => {
  it("① main:ponder / scheduler 前缀（含大小写）识别为临时个体", () => {
    expect(isEphemeralLegacyAgentIdentifier("main:ponder:abc")).toBe(true);
    expect(isEphemeralLegacyAgentIdentifier("scheduler:mission-1")).toBe(true);
    expect(isEphemeralLegacyAgentIdentifier("MAIN:PONDER:XYZ")).toBe(true);
    expect(isEphemeralLegacyAgentIdentifier("tertiary-1")).toBe(false);
  });
});

describe("mission 关联判定", () => {
  it("② 摘要声明了会话但无运行引用 ⇒ 保持独立（声明不是证据）", () => {
    const audit = analyzeLegacyIdentityAssociations(
      buildSnapshot({ missions: [{ missionIdentifier: "mission-1", projectIdentifier: "project-alpha", declaredConversationIdentifier: "conversation-1" }] }),
    );
    expect(audit.linkedMissions).toEqual([]);
    expect(audit.unknownSubjectCount).toBe(1);
    expect(audit.keptIndependent[0]?.reason).toContain("没有可核对的运行记录");
  });

  it("③ 单一会话引用 ⇒ 关联，证据为 single-run-reference", () => {
    const audit = analyzeLegacyIdentityAssociations(
      buildSnapshot({
        conversations: [conversation({ runs: [{ missionIdentifier: "mission-1", agentInstanceIdentifier: "tertiary-1" }] })],
        missions: [{ missionIdentifier: "mission-1", projectIdentifier: "project-alpha", declaredConversationIdentifier: null }],
      }),
    );
    expect(audit.linkedMissions).toEqual([
      { missionIdentifier: "mission-1", conversationIdentifier: "conversation-1", evidence: "single-run-reference" },
    ]);
  });

  it("④ 声明且被同一会话引用 ⇒ 证据优先记为 mission-summary-field", () => {
    const audit = analyzeLegacyIdentityAssociations(
      buildSnapshot({
        conversations: [conversation({ runs: [{ missionIdentifier: "mission-1", agentInstanceIdentifier: "tertiary-1" }] })],
        missions: [{ missionIdentifier: "mission-1", projectIdentifier: "project-alpha", declaredConversationIdentifier: "conversation-1" }],
      }),
    );
    expect(audit.linkedMissions[0]?.evidence).toBe("mission-summary-field");
  });

  it("⑤ 多会话引用 ⇒ 歧义计数 + 保持独立，不做猜测", () => {
    const audit = analyzeLegacyIdentityAssociations(
      buildSnapshot({
        conversations: [
          conversation({ runs: [{ missionIdentifier: "mission-1", agentInstanceIdentifier: "tertiary-1" }] }),
          conversation({
            conversationIdentifier: "conversation-2",
            runs: [{ missionIdentifier: "mission-1", agentInstanceIdentifier: "tertiary-2" }],
          }),
        ],
        missions: [{ missionIdentifier: "mission-1", projectIdentifier: "project-alpha", declaredConversationIdentifier: null }],
      }),
    );
    expect(audit.ambiguousMissionCount).toBe(1);
    expect(audit.linkedMissions).toEqual([]);
    expect(audit.keptIndependent[0]?.reason).toContain("不做猜测");
  });

  it("⑥ 没有任何运行引用 ⇒ 计入未知并保持独立", () => {
    const audit = analyzeLegacyIdentityAssociations(
      buildSnapshot({ missions: [{ missionIdentifier: "mission-1", projectIdentifier: "project-alpha", declaredConversationIdentifier: null }] }),
    );
    expect(audit.unknownSubjectCount).toBe(1);
    expect(audit.keptIndependent[0]?.reason).toContain("无法关联");
  });
});

describe("agent 记忆归属判定", () => {
  it("⑦ 临时个体 ⇒ 记录为 ephemeral 且保持独立（永不合并）", () => {
    const audit = analyzeLegacyIdentityAssociations(
      buildSnapshot({ agentMemoryIdentifiers: ["main:ponder:abc"] }),
    );
    expect(audit.ephemeralAgentIdentifiers).toEqual(["main:ponder:abc"]);
    expect(audit.attributedAgentIndividuals).toEqual([]);
    expect(audit.keptIndependent[0]?.reason).toContain("永不合并");
  });

  it("⑧ 单一会话引用 ⇒ 归属；多会话 ⇒ 不归属且保持独立", () => {
    const single = analyzeLegacyIdentityAssociations(
      buildSnapshot({
        conversations: [conversation({ runs: [{ missionIdentifier: null, agentInstanceIdentifier: "tertiary-1" }] })],
        agentMemoryIdentifiers: ["tertiary-1"],
      }),
    );
    expect(single.attributedAgentIndividuals).toEqual([
      { agentInstanceIdentifier: "tertiary-1", conversationIdentifier: "conversation-1", evidence: "single-conversation-reference" },
    ]);

    const multiple = analyzeLegacyIdentityAssociations(
      buildSnapshot({
        conversations: [
          conversation({ runs: [{ missionIdentifier: null, agentInstanceIdentifier: "tertiary-1" }] }),
          conversation({
            conversationIdentifier: "conversation-2",
            runs: [{ missionIdentifier: null, agentInstanceIdentifier: "tertiary-1" }],
          }),
        ],
        agentMemoryIdentifiers: ["tertiary-1"],
      }),
    );
    expect(multiple.attributedAgentIndividuals).toEqual([]);
    expect(multiple.keptIndependent[0]?.reason).toContain("不做归属猜测");
  });
});

describe("审计只读约束", () => {
  it("⑨ 永远不声称已迁移、不按名字匹配，摘要写明未执行迁移", () => {
    const audit = analyzeLegacyIdentityAssociations(buildSnapshot());
    expect(audit.rulesVersion).toBe(LEGACY_IDENTITY_MIGRATION_RULES_VERSION);
    expect(audit.isMigrationApplied).toBe(false);
    expect(audit.doesApplyNameBasedMatching).toBe(false);
    expect(audit.summaryText).toContain("未执行任何迁移");
  });
});
