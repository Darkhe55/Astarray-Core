/**
 * COORD-03 / 上下文包装配策略（2026-11-17 用户裁决）。
 *
 * 裁决原文要点：
 * - 采用「当前任务绑定包 + 显式依赖引用」组合，**不递归合并**所有依赖节点的完整包；
 * - 引用**固定 revision**；重复内容去重但**保留来源**；
 * - 冲突**不得按节点位置静默覆盖**；任务指令按发布权限与明确修订处理；
 *   事实冲突**提交直属上级裁决**；
 * - 必要内容超预算须**拆分或阻塞**，**不能截断假装完整**。
 *
 * 本模块只做纯判定（无 I/O），由装配方把结果放进提示词；不读磁盘、不发消息。
 */
import type { ContextPack, ContextPackMember } from "./context-pack.js";

export type PackProvenanceKind = "current-task" | "dependency-reference";

export interface DependencyPackReference {
  readonly taskIdentifier: string;
  readonly packIdentifier: string;
  /** 引用时固定下来的 revision：装配只认这个版本，不接受"最新版"。 */
  readonly pinnedRevision: number;
  /** 被引用的包本体（从持久层读出后传入；null 表示缺失/不可读）。 */
  readonly pack: ContextPack | null;
  /** 该包在持久层中的当前 revision（用于发现"引用已过期"）。 */
  readonly currentRevision: number;
  /** 该包所属个体（用于跨个体隔离；缺省视为不可判定 ⇒ 不继承）。 */
  readonly ownerAgentInstanceIdentifier: string | null;
}

export interface PackConflict {
  readonly kind: "instruction" | "fact";
  readonly memberIdentifier: string;
  readonly reason: string;
  /** 指令冲突：按发布权限+修订解析后的胜出来源（事实冲突为空）。 */
  readonly resolvedSourceKind: ContextPackMember["sourceKind"] | null;
}

export interface PackEscalation {
  readonly memberIdentifier: string;
  readonly reason: string;
  readonly involvedPackIdentifiers: readonly string[];
}

export type PackBudgetDecision =
  | { readonly kind: "fits"; readonly characterCount: number }
  | {
      readonly kind: "requires-split";
      readonly characterCount: number;
      readonly maximumCharacterCount: number;
      readonly reason: string;
    }
  | {
      readonly kind: "blocked";
      readonly characterCount: number;
      readonly maximumCharacterCount: number;
      readonly reason: string;
    };

export interface AssembledPacksPlan {
  readonly includedPacks: ReadonlyArray<{
    readonly pack: ContextPack;
    readonly provenance: PackProvenanceKind;
    readonly sourceIdentifier: string;
    readonly pinnedRevision: number;
  }>;
  /** 被排除的引用（未显式引用/版本不符/包缺失）——必须可解释。 */
  readonly excludedReferences: ReadonlyArray<{
    readonly taskIdentifier: string;
    readonly packIdentifier: string;
    readonly reason: string;
  }>;
  /** 去重后的成员：同一内容只出现一次，但保留全部来源。 */
  readonly dedupedMembers: ReadonlyArray<{
    readonly member: ContextPackMember;
    readonly provenances: readonly string[];
  }>;
  readonly conflicts: readonly PackConflict[];
  readonly escalations: readonly PackEscalation[];
  readonly budget: PackBudgetDecision;
}

const SOURCE_AUTHORITY_RANK: Readonly<Record<string, number>> = {
  user: 3,
  agent: 2,
  tool: 1,
};

/** 单条成员的预算长度（与渲染保持同一口径：标识 + 摘要）。 */
function memberCharacterCount(member: ContextPackMember): number {
  return member.memberIdentifier.length + member.summary.length;
}

function dedupeKey(member: ContextPackMember): string {
  /** 有指纹按指纹去重；没有指纹时退化为"标识 + 摘要"，避免把不同内容误合并。 */
  return member.contentFingerprint !== undefined && member.contentFingerprint !== null
    ? `fingerprint:${member.contentFingerprint}`
    : `content:${member.memberIdentifier}\u0000${member.summary}`;
}

/**
 * 装配计划：只接收**当前任务绑定包**与**显式依赖引用**。
 *
 * 刻意不接受"依赖节点的完整包列表"：一旦传入就是递归继承，与本裁决冲突。
 */
export function planContextPackAssembly(input: {
  readonly currentTask: {
    readonly taskIdentifier: string;
    readonly pack: ContextPack | null;
  };
  readonly dependencyReferences: readonly DependencyPackReference[];
  readonly currentAgentInstanceIdentifier: string;
  readonly maximumCharacterCount: number;
}): AssembledPacksPlan {
  const includedPacks: Array<AssembledPacksPlan["includedPacks"][number]> = [];
  const excludedReferences: Array<AssembledPacksPlan["excludedReferences"][number]> = [];

  if (input.currentTask.pack !== null) {
    includedPacks.push({
      pack: input.currentTask.pack,
      provenance: "current-task",
      sourceIdentifier: input.currentTask.taskIdentifier,
      pinnedRevision: 0,
    });
  }

  for (const reference of input.dependencyReferences) {
    /** 跨个体隔离：不是同一个体拥有的包不得因为"在同一任务链上"而进来。 */
    if (
      reference.ownerAgentInstanceIdentifier === null ||
      reference.ownerAgentInstanceIdentifier !== input.currentAgentInstanceIdentifier
    ) {
      excludedReferences.push({
        taskIdentifier: reference.taskIdentifier,
        packIdentifier: reference.packIdentifier,
        reason: `跨个体隔离：包属于 ${String(reference.ownerAgentInstanceIdentifier)}，当前个体 ${input.currentAgentInstanceIdentifier}`,
      });
      continue;
    }
    if (reference.pack === null) {
      excludedReferences.push({
        taskIdentifier: reference.taskIdentifier,
        packIdentifier: reference.packIdentifier,
        reason: "被引用的包缺失/不可读：不按「最新版」兜底",
      });
      continue;
    }
    if (reference.pack.packIdentifier !== reference.packIdentifier) {
      excludedReferences.push({
        taskIdentifier: reference.taskIdentifier,
        packIdentifier: reference.packIdentifier,
        reason: `包标识不一致：引用 ${reference.packIdentifier}，实际 ${reference.pack.packIdentifier}`,
      });
      continue;
    }
    if (reference.currentRevision !== reference.pinnedRevision) {
      excludedReferences.push({
        taskIdentifier: reference.taskIdentifier,
        packIdentifier: reference.packIdentifier,
        reason: `引用版本已过期：固定 ${String(reference.pinnedRevision)}，当前 ${String(reference.currentRevision)}`,
      });
      continue;
    }
    includedPacks.push({
      pack: reference.pack,
      provenance: "dependency-reference",
      sourceIdentifier: reference.taskIdentifier,
      pinnedRevision: reference.pinnedRevision,
    });
  }

  /** 去重：同一内容只保留一份成员，但把所有来源都记下来（不丢出处）。 */
  const membersByDedupeKey = new Map<
    string,
    { member: ContextPackMember; provenances: string[] }
  >();
  for (const included of includedPacks) {
    for (const member of included.pack.members) {
      const key = dedupeKey(member);
      const existing = membersByDedupeKey.get(key);
      const provenance = `${included.provenance}:${included.sourceIdentifier}`;
      if (existing === undefined) {
        membersByDedupeKey.set(key, { member, provenances: [provenance] });
        continue;
      }
      if (!existing.provenances.includes(provenance)) {
        existing.provenances.push(provenance);
      }
    }
  }
  const dedupedMembers = [...membersByDedupeKey.values()];

  /**
   * 冲突检测：同一 `memberIdentifier` 出现**不同内容**才算冲突。
   * 绝不用"包在数组里的先后顺序"决定胜负。
   */
  const conflicts: PackConflict[] = [];
  const escalations: PackEscalation[] = [];
  const membersByIdentifier = new Map<string, ContextPackMember[]>();
  for (const included of includedPacks) {
    for (const member of included.pack.members) {
      const list = membersByIdentifier.get(member.memberIdentifier) ?? [];
      list.push(member);
      membersByIdentifier.set(member.memberIdentifier, list);
    }
  }
  for (const [memberIdentifier, members] of membersByIdentifier) {
    const distinctSummaries = new Set(members.map((member) => member.summary));
    if (distinctSummaries.size <= 1) {
      continue;
    }
    const involvedPackIdentifiers = [
      ...new Set(
        includedPacks
          .filter((included) =>
            included.pack.members.some((member) => member.memberIdentifier === memberIdentifier),
          )
          .map((included) => included.pack.packIdentifier),
      ),
    ];
    /** 指令冲突：按**包的发布权限**（`sourcePriority`）裁决；同权限无法判定 ⇒ 升级，不猜。 */
    const isInstruction = members.every((member) => member.sourceKind === "decision");
    if (!isInstruction) {
      conflicts.push({
        kind: "fact",
        memberIdentifier,
        reason: "同一事实出现不同内容：不按包位置覆盖，需上级裁决",
        resolvedSourceKind: null,
      });
      escalations.push({
        memberIdentifier,
        reason: "事实冲突：提交直属上级裁决",
        involvedPackIdentifiers,
      });
      continue;
    }
    /** 发布权限取**包**的 `sourcePriority`（成员自身不是发布者）。 */
    const packsByMember = includedPacks.filter((included) =>
      included.pack.members.some((member) => member.memberIdentifier === memberIdentifier),
    );
    const sortedByAuthority = [...packsByMember].sort(
      (left, right) =>
        (SOURCE_AUTHORITY_RANK[right.pack.sourcePriority] ?? 0) -
        (SOURCE_AUTHORITY_RANK[left.pack.sourcePriority] ?? 0),
    );
    const highestAuthority = SOURCE_AUTHORITY_RANK[sortedByAuthority[0]!.pack.sourcePriority] ?? 0;
    const sameAuthorityCount = sortedByAuthority.filter(
      (included) => (SOURCE_AUTHORITY_RANK[included.pack.sourcePriority] ?? 0) === highestAuthority,
    ).length;
    if (sameAuthorityCount > 1) {
      conflicts.push({
        kind: "instruction",
        memberIdentifier,
        reason: "指令冲突且发布权限相同：无法按权限判定，需上级裁决",
        resolvedSourceKind: null,
      });
      escalations.push({
        memberIdentifier,
        reason: "指令冲突且同权限：提交直属上级裁决",
        involvedPackIdentifiers,
      });
      continue;
    }
    conflicts.push({
      kind: "instruction",
      memberIdentifier,
      reason: "指令冲突：按发布权限裁决（user > agent > tool）",
      resolvedSourceKind: sortedByAuthority[0]!.pack.sourcePriority,
    });
  }

  /** 预算：整体超限 ⇒ requires-split；含 atomic 包 ⇒ blocked（不能拆也不敢假装完整）。 */
  const characterCount = dedupedMembers.reduce(
    (total, entry) => total + memberCharacterCount(entry.member),
    0,
  );
  let budget: PackBudgetDecision;
  if (characterCount <= input.maximumCharacterCount) {
    budget = { kind: "fits", characterCount };
  } else if (includedPacks.some((included) => included.pack.mergePolicy === "atomic")) {
    budget = {
      kind: "blocked",
      characterCount,
      maximumCharacterCount: input.maximumCharacterCount,
      reason: "必要内容超预算且含 atomic 包：不得截断，只能拆分或阻塞",
    };
  } else {
    budget = {
      kind: "requires-split",
      characterCount,
      maximumCharacterCount: input.maximumCharacterCount,
      reason: "必要内容超预算：必须拆分后注入，不得截断假装完整",
    };
  }

  return { includedPacks, excludedReferences, dedupedMembers, conflicts, escalations, budget };
}
