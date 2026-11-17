/**
 * COORD-03 / 关闭节点回访策略（2026-11-17 用户裁决）。
 *
 * 裁决原文要点：
 * - **默认显式按需回访**，不自动做相关性召回正文；
 * - 任务**预先声明的必要依赖**可在授权下自动读取指定内容；
 * - 运行中的临时历史需求走**工具请求**；
 * - 回访**不重开节点、不恢复任务、不改变原始历史**；
 * - 首版只提供基于**显式引用 / 依赖关系 / 产物关联**的候选索引，
 *   **不引入向量模型或自动上下文决策模型**。
 */
export type RecallCandidateKind =
  | "explicit-reference"
  | "dependency-relation"
  | "artifact-association";

export interface ClosedNodeRecallCandidate {
  readonly contextNodeIdentifier: string;
  readonly sourceRevision: number;
  readonly kind: RecallCandidateKind;
  /** 产物关联时才有的产物标识（其它来源为 null）。 */
  readonly artifactIdentifier: string | null;
}

export interface ClosedNodeRecallSideEffects {
  readonly reopensNode: false;
  readonly resumesTask: false;
  readonly mutatesHistory: false;
}

const READ_ONLY_SIDE_EFFECTS: ClosedNodeRecallSideEffects = {
  reopensNode: false,
  resumesTask: false,
  mutatesHistory: false,
};

/**
 * 候选索引：只从三类**确定性来源**构建，同一节点按 revision 去重（保留最强来源）。
 */
export function buildClosedNodeRecallCandidateIndex(input: {
  readonly explicitReferences?: ReadonlyArray<{
    readonly contextNodeIdentifier: string;
    readonly sourceRevision: number;
  }>;
  readonly dependencyRelations?: ReadonlyArray<{
    readonly contextNodeIdentifier: string;
    readonly sourceRevision: number;
  }>;
  readonly artifactAssociations?: ReadonlyArray<{
    readonly contextNodeIdentifier: string;
    readonly sourceRevision: number;
    readonly artifactIdentifier: string;
  }>;
}): readonly ClosedNodeRecallCandidate[] {
  const candidatesByNode = new Map<string, ClosedNodeRecallCandidate>();
  /** 优先级：显式引用 > 依赖关系 > 产物关联（同节点保留更强来源）。 */
  const priority: Record<RecallCandidateKind, number> = {
    "explicit-reference": 3,
    "dependency-relation": 2,
    "artifact-association": 1,
  };
  const consider = (candidate: ClosedNodeRecallCandidate): void => {
    const key = `${candidate.contextNodeIdentifier}@${String(candidate.sourceRevision)}`;
    const existing = candidatesByNode.get(key);
    if (existing === undefined || priority[candidate.kind] > priority[existing.kind]) {
      candidatesByNode.set(key, candidate);
    }
  };
  for (const reference of input.explicitReferences ?? []) {
    consider({
      contextNodeIdentifier: reference.contextNodeIdentifier,
      sourceRevision: reference.sourceRevision,
      kind: "explicit-reference",
      artifactIdentifier: null,
    });
  }
  for (const relation of input.dependencyRelations ?? []) {
    consider({
      contextNodeIdentifier: relation.contextNodeIdentifier,
      sourceRevision: relation.sourceRevision,
      kind: "dependency-relation",
      artifactIdentifier: null,
    });
  }
  for (const association of input.artifactAssociations ?? []) {
    consider({
      contextNodeIdentifier: association.contextNodeIdentifier,
      sourceRevision: association.sourceRevision,
      kind: "artifact-association",
      artifactIdentifier: association.artifactIdentifier,
    });
  }
  return [...candidatesByNode.values()];
}

/**
 * WIRING-04-05：**按产物关联排序候选**（不新增存储）。
 *
 * 依据现成数据：胶囊自带 `artifactOrCommitReferences`，产物登记带 mission + location。
 * 命中"当前 mission 产物"的胶囊排在前面，其次保持原有顺序；**只重排，不扩大候选集**。
 */
export function orderRecallCandidatesByArtifactAssociation(input: {
  readonly capsules: ReadonlyArray<{
    readonly contextNodeIdentifier: string;
    readonly sourceRevision: number;
    readonly artifactOrCommitReferences?: readonly string[];
  }>;
  readonly missionArtifactLocations: readonly string[];
}): ReadonlyArray<{
  readonly contextNodeIdentifier: string;
  readonly sourceRevision: number;
}> {
  const artifactLocations = new Set(
    input.missionArtifactLocations.map((location) => location.trim()).filter((l) => l !== ""),
  );
  const matchesArtifact = (capsule: {
    readonly artifactOrCommitReferences?: readonly string[];
  }): boolean => {
    if (artifactLocations.size === 0) {
      return false;
    }
    return (capsule.artifactOrCommitReferences ?? []).some((reference) =>
      artifactLocations.has(reference.trim()),
    );
  };
  /** 稳定排序：命中产物关联的在前，其余保持原顺序。 */
  const ordered = [
    ...input.capsules.filter((capsule) => matchesArtifact(capsule)),
    ...input.capsules.filter((capsule) => !matchesArtifact(capsule)),
  ];
  return ordered.map((capsule) => ({
    contextNodeIdentifier: capsule.contextNodeIdentifier,
    sourceRevision: capsule.sourceRevision,
  }));
}

/**
 * **自动相关性召回：首版恒为空**。
 *
 * 这不是"还没实现"，而是裁决要求：没有向量模型/自动决策模型时，
 * 自动召回只能靠猜，猜错会把无关正文塞进提示词。
 */
export function selectAutomaticRecallCandidates(): readonly ClosedNodeRecallCandidate[] {
  return [];
}

export interface ClosedNodeRecallDecision {
  readonly isAllowed: boolean;
  readonly reason: string;
  readonly sideEffects: ClosedNodeRecallSideEffects;
}

/**
 * 判定一次回访请求。
 *
 * - `on-demand`（运行中临时需求）：必须命中**显式引用**候选，且已被授权；
 * - `pre-declared-dependency`（任务预先声明的必要依赖）：可命中依赖关系候选，
 *   同样要求授权，并**固定 sourceRevision**；
 * - 其它情况一律拒绝（不猜、不自动召回）。
 */
export function evaluateClosedNodeRecall(input: {
  readonly requestKind: "on-demand" | "pre-declared-dependency";
  readonly request: {
    readonly contextNodeIdentifier: string;
    readonly sourceRevision: number;
  };
  readonly candidates: readonly ClosedNodeRecallCandidate[];
  readonly isAuthorized: boolean;
}): ClosedNodeRecallDecision {
  const matchedCandidate = input.candidates.find(
    (candidate) =>
      candidate.contextNodeIdentifier === input.request.contextNodeIdentifier &&
      candidate.sourceRevision === input.request.sourceRevision,
  );
  if (matchedCandidate === undefined) {
    return {
      isAllowed: false,
      reason: "未命中候选索引：不按相关性猜测正文",
      sideEffects: READ_ONLY_SIDE_EFFECTS,
    };
  }
  if (!input.isAuthorized) {
    return {
      isAllowed: false,
      reason: "缺少读取授权：回访正文需要授权（不因「已关闭」而放宽）",
      sideEffects: READ_ONLY_SIDE_EFFECTS,
    };
  }
  if (input.requestKind === "on-demand" && matchedCandidate.kind !== "explicit-reference") {
    return {
      isAllowed: false,
      reason: "按需回访只接受显式引用命中的节点",
      sideEffects: READ_ONLY_SIDE_EFFECTS,
    };
  }
  return {
    isAllowed: true,
    reason: "命中候选且已授权：只读返回，不重开节点、不恢复任务、不改历史",
    sideEffects: READ_ONLY_SIDE_EFFECTS,
  };
}
