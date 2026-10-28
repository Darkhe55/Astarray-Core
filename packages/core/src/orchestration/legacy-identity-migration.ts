/**
 * ALIGN-01-07（2026-10-28）：**旧身份映射的只读迁移分析**。
 *
 * 卡内规则：旧身份映射只能根据**可核对关联**迁移；不能按同名角色拼接历史；
 * 无唯一关联保持独立并标未知。
 *
 * 本模块**不迁移、不写盘**：它把磁盘上的旧记录读成快照，产出一份"哪些能关联、
 * 依据是什么、哪些只能保持独立"的判定结果。ALIGN-04 的只读对账与 CLI/SDK 的
 * 迁移审计都消费这份结果；真正的写回要另走显式授权入口（本检查点不做）。
 *
 * 四条判定规则（确定性，可逐条核对）：
 * 1. **声明 + 运行记录一致**才关联：mission 摘要里写了 conversationIdentifier，
 *    且该会话的运行记录确实引用了这个 mission ⇒ 证据 `mission-summary-field`。
 * 2. **唯一运行引用**才关联：mission 没有声明会话，但**恰好一个**会话的运行记录
 *    引用了它 ⇒ 证据 `single-run-reference`。
 * 3. **多个会话引用 ⇒ 保持独立**（标 ambiguous）：不做"挑最近的那个"这类猜测。
 * 4. **绝不按名字合并**：`main:ponder:*` / `scheduler:*` 这类每次调用/每个 mission
 *    生成的标识**永不合并**（标 ephemeral）；Agent 记忆目录只在**恰好一个**会话
 *    引用该个体时才归属，否则保持独立并标未知。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { decodePathSegment } from "./work-archive-store.js";

export const LEGACY_IDENTITY_MIGRATION_RULES_VERSION = 1;

/** 每次调用/每个 mission 生成的身份形态：永不合并，只能保持独立。 */
const EPHEMERAL_AGENT_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /^main:ponder:/i,
  /^scheduler:/i,
];

export interface LegacyConversationRunSnapshot {
  readonly missionIdentifier: string | null;
  readonly agentInstanceIdentifier: string;
}

export interface LegacyConversationSnapshot {
  readonly conversationIdentifier: string;
  readonly projectIdentifier: string;
  readonly mainAgentInstanceIdentifier: string;
  readonly runs: readonly LegacyConversationRunSnapshot[];
}

export interface LegacyMissionSnapshot {
  readonly missionIdentifier: string;
  readonly projectIdentifier: string | null;
  readonly declaredConversationIdentifier: string | null;
}

export interface LegacyIdentitySnapshot {
  readonly conversations: readonly LegacyConversationSnapshot[];
  readonly missions: readonly LegacyMissionSnapshot[];
  /** Agent 记忆目录反解后的个体标识（`decodePathSegment`）。 */
  readonly agentMemoryIdentifiers: readonly string[];
}

export type LegacyLinkEvidence =
  | "mission-summary-field"
  | "single-run-reference";

export interface LegacyMissionLink {
  readonly missionIdentifier: string;
  readonly conversationIdentifier: string;
  readonly evidence: LegacyLinkEvidence;
}

export interface LegacyIndividualAttribution {
  readonly agentInstanceIdentifier: string;
  readonly conversationIdentifier: string;
  readonly evidence: "single-conversation-reference";
}

export interface LegacyIdentityKeptIndependent {
  readonly subjectIdentifier: string;
  readonly subjectKind: "mission" | "agent-memory";
  readonly reason: string;
}

export interface LegacyIdentityAudit {
  readonly rulesVersion: number;
  readonly isMigrationApplied: false;
  readonly doesApplyNameBasedMatching: false;
  readonly linkedMissions: readonly LegacyMissionLink[];
  readonly attributedAgentIndividuals: readonly LegacyIndividualAttribution[];
  readonly keptIndependent: readonly LegacyIdentityKeptIndependent[];
  /** 多次会话引用同一 mission 的 mission 数（保持独立）。 */
  readonly ambiguousMissionCount: number;
  /** 每次调用/每 mission 生成的临时个体（保持独立，永不合并）。 */
  readonly ephemeralAgentIdentifiers: readonly string[];
  /** 无法判断归属的主体数（mission + agent memory）。 */
  readonly unknownSubjectCount: number;
  readonly summaryText: string;
}

export function isEphemeralLegacyAgentIdentifier(identifier: string): boolean {
  return EPHEMERAL_AGENT_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(identifier));
}

/**
 * 纯判定：把快照变成"可关联 / 保持独立"的审计结果。
 *
 * 不读盘、不改写；相同输入永远得到相同输出（便于对账与复跑）。
 */
export function analyzeLegacyIdentityAssociations(
  snapshot: LegacyIdentitySnapshot,
): LegacyIdentityAudit {
  const conversationsByMission = new Map<string, Set<string>>();
  const conversationsByAgent = new Map<string, Set<string>>();
  for (const conversation of snapshot.conversations) {
    for (const run of conversation.runs) {
      if (run.missionIdentifier !== null && run.missionIdentifier !== "") {
        const missionConversations =
          conversationsByMission.get(run.missionIdentifier) ?? new Set<string>();
        missionConversations.add(conversation.conversationIdentifier);
        conversationsByMission.set(run.missionIdentifier, missionConversations);
      }
      if (run.agentInstanceIdentifier !== "") {
        const agentConversations =
          conversationsByAgent.get(run.agentInstanceIdentifier) ?? new Set<string>();
        agentConversations.add(conversation.conversationIdentifier);
        conversationsByAgent.set(run.agentInstanceIdentifier, agentConversations);
      }
    }
  }

  const linkedMissions: LegacyMissionLink[] = [];
  const keptIndependent: LegacyIdentityKeptIndependent[] = [];
  let ambiguousMissionCount = 0;
  let unknownSubjectCount = 0;

  for (const mission of snapshot.missions) {
    const referencingConversations =
      conversationsByMission.get(mission.missionIdentifier) ?? new Set<string>();
    const declaredConversationIdentifier = mission.declaredConversationIdentifier;

    if (declaredConversationIdentifier !== null && declaredConversationIdentifier !== "") {
      if (referencingConversations.has(declaredConversationIdentifier)) {
        linkedMissions.push({
          missionIdentifier: mission.missionIdentifier,
          conversationIdentifier: declaredConversationIdentifier,
          evidence: "mission-summary-field",
        });
      } else {
        /**
         * 摘要写了会话，但**没有任何运行记录**把该 mission 连到那个会话
         * ⇒ 声明不是证据，保持独立（不按"它自己说"就迁移）。
         */
        keptIndependent.push({
          subjectIdentifier: mission.missionIdentifier,
          subjectKind: "mission",
          reason: "摘要声明了会话标识，但没有可核对的运行记录引用该 mission",
        });
        unknownSubjectCount += 1;
      }
      continue;
    }

    if (referencingConversations.size === 1) {
      const [onlyConversationIdentifier] = [...referencingConversations];
      if (onlyConversationIdentifier !== undefined) {
        linkedMissions.push({
          missionIdentifier: mission.missionIdentifier,
          conversationIdentifier: onlyConversationIdentifier,
          evidence: "single-run-reference",
        });
      }
      continue;
    }
    if (referencingConversations.size > 1) {
      ambiguousMissionCount += 1;
      keptIndependent.push({
        subjectIdentifier: mission.missionIdentifier,
        subjectKind: "mission",
        reason: `多个会话（${String(referencingConversations.size)} 个）引用该 mission，不做猜测`,
      });
      continue;
    }
    keptIndependent.push({
      subjectIdentifier: mission.missionIdentifier,
      subjectKind: "mission",
      reason: "没有会话运行记录引用该 mission（旧记录，无法关联）",
    });
    unknownSubjectCount += 1;
  }

  const attributedAgentIndividuals: LegacyIndividualAttribution[] = [];
  const ephemeralAgentIdentifiers: string[] = [];
  for (const agentInstanceIdentifier of snapshot.agentMemoryIdentifiers) {
    if (isEphemeralLegacyAgentIdentifier(agentInstanceIdentifier)) {
      ephemeralAgentIdentifiers.push(agentInstanceIdentifier);
      keptIndependent.push({
        subjectIdentifier: agentInstanceIdentifier,
        subjectKind: "agent-memory",
        reason: "每次调用生成的临时个体：永不合并，保持独立",
      });
      continue;
    }
    const agentConversations = conversationsByAgent.get(agentInstanceIdentifier);
    if (agentConversations !== undefined && agentConversations.size === 1) {
      const [onlyConversationIdentifier] = [...agentConversations];
      if (onlyConversationIdentifier !== undefined) {
        attributedAgentIndividuals.push({
          agentInstanceIdentifier,
          conversationIdentifier: onlyConversationIdentifier,
          evidence: "single-conversation-reference",
        });
      }
      continue;
    }
    if (agentConversations !== undefined && agentConversations.size > 1) {
      keptIndependent.push({
        subjectIdentifier: agentInstanceIdentifier,
        subjectKind: "agent-memory",
        reason: `该个体出现在多个会话（${String(agentConversations.size)} 个）中，不做归属猜测`,
      });
      continue;
    }
    keptIndependent.push({
      subjectIdentifier: agentInstanceIdentifier,
      subjectKind: "agent-memory",
      reason: "没有任何会话运行记录引用该个体（归属未知）",
    });
    unknownSubjectCount += 1;
  }

  return {
    rulesVersion: LEGACY_IDENTITY_MIGRATION_RULES_VERSION,
    isMigrationApplied: false,
    doesApplyNameBasedMatching: false,
    linkedMissions,
    attributedAgentIndividuals,
    keptIndependent,
    ambiguousMissionCount,
    ephemeralAgentIdentifiers,
    unknownSubjectCount,
    summaryText:
      `可关联 mission ${linkedMissions.length} 个、个体 ${attributedAgentIndividuals.length} 个；` +
      `保持独立 ${keptIndependent.length} 项（其中多会话歧义 ${ambiguousMissionCount} 个、` +
      `无法判断 ${unknownSubjectCount} 个、临时个体 ${ephemeralAgentIdentifiers.length} 个）；` +
      `本审计只读，未执行任何迁移。`,
  };
}

/**
 * 从状态目录收集快照（只读）。
 *
 * 读取失败按"该项不存在"处理（旧目录缺文件是常态），不把缺失当损坏，
 * 也不因此伪造关联。
 */
export async function collectLegacyIdentitySnapshot(input: {
  readonly stateDirectory: string;
}): Promise<LegacyIdentitySnapshot> {
  const conversationsFilePath = path.join(
    input.stateDirectory,
    "conversation-identity",
    "conversations.json",
  );
  const conversations: LegacyConversationSnapshot[] = [];
  try {
    const rawContent = await fs.readFile(conversationsFilePath, "utf8");
    const parsed = JSON.parse(rawContent) as {
      conversations?: Record<
        string,
        {
          projectIdentifier?: unknown;
          mainAgentInstanceIdentifier?: unknown;
          runs?: Array<{ missionIdentifier?: unknown; agentInstanceIdentifier?: unknown }>;
        }
      >;
    };
    for (const [conversationIdentifier, record] of Object.entries(parsed.conversations ?? {})) {
      conversations.push({
        conversationIdentifier,
        projectIdentifier:
          typeof record.projectIdentifier === "string" ? record.projectIdentifier : "",
        mainAgentInstanceIdentifier:
          typeof record.mainAgentInstanceIdentifier === "string"
            ? record.mainAgentInstanceIdentifier
            : "",
        runs: (record.runs ?? []).map((run) => ({
          missionIdentifier:
            typeof run.missionIdentifier === "string" ? run.missionIdentifier : null,
          agentInstanceIdentifier:
            typeof run.agentInstanceIdentifier === "string"
              ? run.agentInstanceIdentifier
              : "",
        })),
      });
    }
  } catch {
    // 没有身份映射文件（旧版本状态目录）⇒ 空快照
  }

  const missions: LegacyMissionSnapshot[] = [];
  const missionsDirectoryPath = path.join(input.stateDirectory, "missions");
  let missionDirectoryNames: string[];
  try {
    missionDirectoryNames = await fs.readdir(missionsDirectoryPath);
  } catch {
    missionDirectoryNames = [];
  }
  for (const missionDirectoryName of missionDirectoryNames) {
    const summaryFilePath = path.join(
      missionsDirectoryPath,
      missionDirectoryName,
      "summary.json",
    );
    let summary: { projectIdentifier?: unknown; conversationIdentifier?: unknown } | null;
    try {
      summary = JSON.parse(await fs.readFile(summaryFilePath, "utf8")) as {
        projectIdentifier?: unknown;
        conversationIdentifier?: unknown;
      };
    } catch {
      summary = null;
    }
    if (summary === null) {
      continue;
    }
    missions.push({
      missionIdentifier: missionDirectoryName,
      projectIdentifier:
        typeof summary.projectIdentifier === "string" ? summary.projectIdentifier : null,
      declaredConversationIdentifier:
        typeof summary.conversationIdentifier === "string"
          ? summary.conversationIdentifier
          : null,
    });
  }

  const agentMemoryIdentifiers: string[] = [];
  const agentMemoryDirectoryPath = path.join(input.stateDirectory, "agent-memory");
  try {
    const agentMemoryDirectoryNames = await fs.readdir(agentMemoryDirectoryPath);
    for (const encodedDirectoryName of agentMemoryDirectoryNames) {
      agentMemoryIdentifiers.push(decodePathSegment(encodedDirectoryName));
    }
  } catch {
    // 没有个体记忆目录 ⇒ 空
  }

  return {
    conversations,
    missions,
    agentMemoryIdentifiers: [...new Set(agentMemoryIdentifiers)],
  };
}
