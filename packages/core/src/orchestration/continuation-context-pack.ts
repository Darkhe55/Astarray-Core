/**
 * RESUME-02（2026-11-24，检查点 04 的**纯装配层**）：有界恢复包。
 *
 * 规则（卡内固定）：
 * - 窗口预算 = 模型窗口 − 系统/工具说明 − 输出预留 − 安全余量；
 *   全局预算（默认 4096）独立执行并与窗口预算取更严；
 * - 无关/已关闭节点先移出，**后继内容留磁盘**（只留引用，不丢内容）；
 * - 当前前置节点优先；安全约束**不得因预算静默截断**——装不下就阻塞；
 * - 缺少可靠窗口/计量 ⇒ 明确标记为估算；无法确定最小包能容纳 ⇒ 阻塞。
 *
 * 本层不读文件、不调用模型：输入由调用方注入，输出可测试、可审计。
 */
export const DEFAULT_CONTINUATION_GLOBAL_BUDGET_TOKENS = 4096;

export interface ContinuationPackNode {
  readonly taskIdentifier: string;
  /** 节点原始 revision（装配必须绑定，不合并兄弟 Agent 档案）。 */
  readonly revision: number;
  readonly contentHash: string;
  readonly estimatedTokens: number;
  readonly isClosedOrIrrelevant: boolean;
  readonly isCurrentPrerequisite: boolean;
  /** 安全约束原文（不参与"可裁剪"集合）。 */
  readonly securityConstraints: readonly string[];
  /** 节点正文（可留磁盘；装配只带摘要片段）。 */
  readonly excerpt: string;
}

export interface ContinuationPackRequest {
  readonly targetTaskIdentifier: string;
  readonly expectedRevision: number;
  /** 模型窗口；`null` 表示未知（不得猜测无限窗口）。 */
  readonly modelWindowTokens: number | null;
  readonly systemAndToolTokens: number;
  readonly outputReserveTokens: number;
  readonly safetyMarginTokens: number;
  /** 全局上下文预算（用户设置）；缺省 4096。 */
  readonly globalBudgetTokens?: number;
  readonly nodes: readonly ContinuationPackNode[];
  readonly isTokenEstimate: boolean;
}

export interface ContinuationPackEntry {
  readonly taskIdentifier: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly excerpt: string;
  readonly isCurrentPrerequisite: boolean;
}

export type ContinuationPackResult =
  | {
      readonly kind: "assembled";
      readonly entries: readonly ContinuationPackEntry[];
      readonly leftOnDiskTaskIdentifiers: readonly string[];
      readonly usedTokens: number;
      readonly availableTokens: number;
      readonly isTokenEstimate: boolean;
      readonly securityConstraintCount: number;
    }
  | {
      readonly kind: "blocked";
      readonly reasonCode:
        | "model-window-unknown"
        | "budget-non-positive"
        | "security-constraints-exceed-budget"
        | "minimal-pack-exceeds-budget";
      readonly detail: string;
    };

function estimateConstraintTokens(node: ContinuationPackNode): number {
  /** 安全约束按字符数/4 保守估算（宁可多算）。 */
  return node.securityConstraints.reduce(
    (total, constraint) => total + Math.ceil(constraint.length / 4),
    0,
  );
}

export function assembleContinuationPack(
  request: ContinuationPackRequest,
): ContinuationPackResult {
  if (request.modelWindowTokens === null || request.modelWindowTokens <= 0) {
    return {
      kind: "blocked",
      reasonCode: "model-window-unknown",
      detail: "缺少可靠模型窗口：不猜测无限窗口，请选择已知窗口的模型后再装配。",
    };
  }
  const globalBudget =
    request.globalBudgetTokens ?? DEFAULT_CONTINUATION_GLOBAL_BUDGET_TOKENS;
  const windowBudget =
    request.modelWindowTokens -
    request.systemAndToolTokens -
    request.outputReserveTokens -
    request.safetyMarginTokens;
  const availableTokens = Math.min(windowBudget, globalBudget);
  if (availableTokens <= 0) {
    return {
      kind: "blocked",
      reasonCode: "budget-non-positive",
      detail: "扣除系统/工具说明、输出预留与安全余量后没有可用预算。",
    };
  }

  /** 安全约束必须先计入；装不下即阻塞（绝不静默截断）。 */
  const securityConstraintCount = request.nodes.reduce(
    (total, node) => total + node.securityConstraints.length,
    0,
  );
  const constraintTokens = request.nodes.reduce(
    (total, node) => total + estimateConstraintTokens(node),
    0,
  );
  if (constraintTokens > availableTokens) {
    return {
      kind: "blocked",
      reasonCode: "security-constraints-exceed-budget",
      detail: `安全约束约需 ${String(constraintTokens)} token，超过可用 ${String(availableTokens)}：不得截断约束，请换模型或释放上下文。`,
    };
  }

  /** 无关/已关闭节点先移出（内容留磁盘，只记引用）。 */
  const relevantNodes = request.nodes.filter((node) => !node.isClosedOrIrrelevant);
  const leftOnDiskTaskIdentifiers = request.nodes
    .filter((node) => node.isClosedOrIrrelevant)
    .map((node) => node.taskIdentifier);

  /** 当前前置节点优先，其余按输入顺序。 */
  const orderedNodes = [
    ...relevantNodes.filter((node) => node.isCurrentPrerequisite),
    ...relevantNodes.filter((node) => !node.isCurrentPrerequisite),
  ];

  let usedTokens = 0;
  const entries: ContinuationPackEntry[] = [];
  for (const node of orderedNodes) {
    const nodeCost = node.estimatedTokens + estimateConstraintTokens(node);
    if (usedTokens + nodeCost > availableTokens) {
      leftOnDiskTaskIdentifiers.push(node.taskIdentifier);
      continue;
    }
    usedTokens += nodeCost;
    entries.push({
      taskIdentifier: node.taskIdentifier,
      revision: node.revision,
      contentHash: node.contentHash,
      excerpt: node.excerpt,
      isCurrentPrerequisite: node.isCurrentPrerequisite,
    });
  }

  if (entries.length === 0) {
    return {
      kind: "blocked",
      reasonCode: "minimal-pack-exceeds-budget",
      detail: "最小恢复包（至少一个必要节点）无法容纳：请换用更大窗口或缩小任务范围。",
    };
  }
  return {
    kind: "assembled",
    entries,
    leftOnDiskTaskIdentifiers,
    usedTokens,
    availableTokens,
    isTokenEstimate: request.isTokenEstimate,
    securityConstraintCount,
  };
}
