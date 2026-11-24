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

/**
 * RESUME-02 补口（2026-11-25）：**真实内容读取 + 注入前扫描**的装配入口。
 *
 * 卡内要求："内容扫描与权限检查必须发生在实际注入前"。此处的纪律：
 * - 内容来自磁盘（注入的读取器），**不信任调用方直接给的 excerpt**；
 * - 扫描器报出敏感内容 ⇒ **该节点不回填**（留在磁盘、记入 `withheldTaskIdentifiers`），
 *   不做"扫描后照抄"的假动作；
 * - 扫描器抛错 ⇒ 整体 **blocked（scan-failed）**，不降级为"当作干净"；
 * - 所有必要节点都被扣留 ⇒ `blocked/sensitive-content-withheld`（不静默拼一个空包）。
 * - token 用"字符数/4"保守估算并标记 `isTokenEstimate=true`（没有 tokenizer）。
 */
export interface ContinuationDiskNode {
  readonly taskIdentifier: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly filePath: string;
  readonly isClosedOrIrrelevant: boolean;
  readonly isCurrentPrerequisite: boolean;
  readonly securityConstraints: readonly string[];
}

export interface ContinuationDiskScanFinding {
  readonly ruleIdentifier: string;
}

export type ContinuationPackFromDiskResult =
  | {
      readonly kind: "assembled";
      readonly pack: Extract<ContinuationPackResult, { kind: "assembled" }>;
      /** 因敏感内容被扣留、只留在磁盘的节点。 */
      readonly withheldTaskIdentifiers: readonly string[];
      /** 读取失败、未参与装配的节点。 */
      readonly unreadableTaskIdentifiers: readonly string[];
    }
  | {
      readonly kind: "blocked";
      readonly reasonCode:
        | "scan-failed"
        | "sensitive-content-withheld"
        | "no-readable-nodes"
        | "model-window-unknown"
        | "budget-non-positive"
        | "security-constraints-exceed-budget"
        | "minimal-pack-exceeds-budget";
      readonly detail: string;
      readonly withheldTaskIdentifiers: readonly string[];
      readonly unreadableTaskIdentifiers: readonly string[];
    };

function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildExcerpt(text: string, maximumCharacters = 600): string {
  if (text.length <= maximumCharacters) return text;
  return `${text.slice(0, maximumCharacters)}…（已截断，原文留磁盘）`;
}

export async function assembleContinuationPackFromDisk(input: {
  readonly request: Omit<ContinuationPackRequest, "nodes" | "isTokenEstimate">;
  readonly nodes: readonly ContinuationDiskNode[];
  readonly readFile: (filePath: string) => Promise<string>;
  readonly scan: (content: string) => Promise<readonly ContinuationDiskScanFinding[]>;
}): Promise<ContinuationPackFromDiskResult> {
  const withheldTaskIdentifiers: string[] = [];
  const unreadableTaskIdentifiers: string[] = [];
  const packNodes: ContinuationPackNode[] = [];

  for (const node of input.nodes) {
    let content: string;
    try {
      content = await input.readFile(node.filePath);
    } catch {
      unreadableTaskIdentifiers.push(node.taskIdentifier);
      continue;
    }
    let findings: readonly ContinuationDiskScanFinding[];
    try {
      findings = await input.scan(content);
    } catch (error) {
      return {
        kind: "blocked",
        reasonCode: "scan-failed",
        detail: `扫描失败，拒绝回填（不当作干净内容）：${(error as Error).message}`,
        withheldTaskIdentifiers,
        unreadableTaskIdentifiers,
      };
    }
    if (findings.length > 0) {
      withheldTaskIdentifiers.push(node.taskIdentifier);
      continue;
    }
    packNodes.push({
      taskIdentifier: node.taskIdentifier,
      revision: node.revision,
      contentHash: node.contentHash,
      estimatedTokens: estimateTokensFromText(content),
      isClosedOrIrrelevant: node.isClosedOrIrrelevant,
      isCurrentPrerequisite: node.isCurrentPrerequisite,
      securityConstraints: node.securityConstraints,
      excerpt: buildExcerpt(content),
    });
  }

  if (packNodes.length === 0) {
    if (withheldTaskIdentifiers.length > 0) {
      return {
        kind: "blocked",
        reasonCode: "sensitive-content-withheld",
        detail: "所有候选节点的内容都被扫描规则扣留：不得用空包冒充恢复包。",
        withheldTaskIdentifiers,
        unreadableTaskIdentifiers,
      };
    }
    return {
      kind: "blocked",
      reasonCode: "no-readable-nodes",
      detail: "没有任何可读节点：无法装配恢复包。",
      withheldTaskIdentifiers,
      unreadableTaskIdentifiers,
    };
  }

  const pack = assembleContinuationPack({
    ...input.request,
    nodes: packNodes,
    isTokenEstimate: true,
  });
  if (pack.kind === "blocked") {
    return {
      kind: "blocked",
      reasonCode: pack.reasonCode,
      detail: pack.detail,
      withheldTaskIdentifiers,
      unreadableTaskIdentifiers,
    };
  }
  return {
    kind: "assembled",
    pack,
    withheldTaskIdentifiers,
    unreadableTaskIdentifiers,
  };
}