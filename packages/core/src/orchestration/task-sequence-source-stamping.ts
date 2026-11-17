/**
 * WIRING-04-04（方案 A）：把候选稿声明的来源变成**权威来源三元组**。
 *
 * 候选稿只能声明"我来自哪条用户任务"（一个 id）；序列标识与属主属于权威信息，
 * 由装配层按 mission 上下文补齐。声明与已知用户任务不一致 ⇒ **剥离并报告**，不采信。
 */
import type { TaskDependencyNode } from "../core/types.js";

export interface DeclaredSourceStampingResult {
  readonly nodes: TaskDependencyNode[];
  /** 已补齐三个来源字段的节点 id（调用方据此建立精确映射）。 */
  readonly stampedMissionTaskIdentifiers: string[];
  /** 候选稿声明了来源但无法采信的节点 id（已剥离声明）。 */
  readonly rejectedMissionTaskIdentifiers: string[];
}

export function stampDeclaredSequenceSources(input: {
  readonly nodes: readonly TaskDependencyNode[];
  /** 该 mission 权威的用户任务标识与序列上下文（缺任意一项 ⇒ 无法补齐）。 */
  readonly originalTaskIdentifier: string | null;
  readonly sequenceIdentifier: string | null;
  readonly ownerAgentInstanceIdentifier: string | null;
}): DeclaredSourceStampingResult {
  const canStamp =
    input.originalTaskIdentifier !== null &&
    input.originalTaskIdentifier.trim() !== "" &&
    input.sequenceIdentifier !== null &&
    input.sequenceIdentifier.trim() !== "" &&
    input.ownerAgentInstanceIdentifier !== null &&
    input.ownerAgentInstanceIdentifier.trim() !== "";

  const stampedMissionTaskIdentifiers: string[] = [];
  const rejectedMissionTaskIdentifiers: string[] = [];

  const nodes = input.nodes.map((node) => {
    const declared = node.sourceSequenceTaskIdentifier;
    if (declared === undefined) {
      return node;
    }
    if (!canStamp || declared !== input.originalTaskIdentifier) {
      /** 无法采信：剥离声明，避免"看起来有来源其实没对上"。 */
      const nodeWithoutSource: TaskDependencyNode = { ...node };
      delete nodeWithoutSource.sourceSequenceTaskIdentifier;
      rejectedMissionTaskIdentifiers.push(node.id);
      return nodeWithoutSource;
    }
    stampedMissionTaskIdentifiers.push(node.id);
    return {
      ...node,
      sourceSequenceTaskIdentifier: declared,
      sourceSequenceIdentifier: input.sequenceIdentifier as string,
      sourceSequenceOwnerAgentInstanceIdentifier:
        input.ownerAgentInstanceIdentifier as string,
    };
  });

  return { nodes, stampedMissionTaskIdentifiers, rejectedMissionTaskIdentifiers };
}
