/**
 * D2（2026-11-23 产品裁决）：**派发前已取消的序列节点不得启动**。
 *
 * 首版采用"个体序列节点取消"：派发层在把候选节点变成 mission 任务之前，
 * 用权威序列快照过滤掉已取消节点；全部被过滤时直接拒绝创建 mission
 * （因此不会启动 worker，也不会产生提案文件）。
 */
export interface SequenceSourcedNode {
  readonly sourceSequenceTaskIdentifier?: string;
}

export interface SequenceDispatchFilterResult<Node extends SequenceSourcedNode> {
  readonly dispatchableNodes: Node[];
  /** 因来源节点已取消而被阻止派发的 mission 节点标识（用于日志/审计）。 */
  readonly blockedSourceSequenceTaskIdentifiers: string[];
}

export function filterDispatchableSequenceNodes<Node extends SequenceSourcedNode>(input: {
  readonly nodes: ReadonlyArray<Node>;
  readonly cancelledSequenceTaskIdentifiers: ReadonlySet<string>;
}): SequenceDispatchFilterResult<Node> {
  const dispatchableNodes: Node[] = [];
  const blocked = new Set<string>();
  for (const node of input.nodes) {
    const source = node.sourceSequenceTaskIdentifier;
    if (source !== undefined && input.cancelledSequenceTaskIdentifiers.has(source)) {
      blocked.add(source);
      continue;
    }
    dispatchableNodes.push(node);
  }
  return {
    dispatchableNodes,
    blockedSourceSequenceTaskIdentifiers: [...blocked].sort(),
  };
}

export function isEveryDispatchableNodeBlocked<Node extends SequenceSourcedNode>(
  result: SequenceDispatchFilterResult<Node>,
): boolean {
  return result.dispatchableNodes.length === 0 && result.blockedSourceSequenceTaskIdentifiers.length > 0;
}
