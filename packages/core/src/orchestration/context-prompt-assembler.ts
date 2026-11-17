/**
 * 上下文提示词装配（T09A-R1-01 / ADR-0031）。
 *
 * 规则：
 * - 系统规则与任务必要条件独立于可选全局记录，始终进入提示词；
 * - 全局记录只注入“相关且 active 且预算内”的选择结果（无关记录不注入）；
 * - 局部活跃前沿只注入未关闭节点的标识/状态/指纹，已关闭节点只计数、不注入原文；
 * - 必要条件缺失时报告给调用方阻塞，不静默执行。
 */
import type { TaskDependencyNode } from "../core/types.js";
import { DomainError } from "../core/errors.js";
import { buildPromptActiveFrontier } from "./context-closure-capsule-store.js";
import type { GlobalDecisionStore } from "./global-decision-store.js";
import type { GlobalDecisionRecord } from "./context-closure-schemas.js";
import { selectGlobalDecisionsForTask } from "./global-decision-selector.js";
import { estimateRecallTokenCount } from "./context-recall-controller.js";
import type { ContextAssemblyRuntimeEvent } from "./context-runtime-metrics.js";
import type { LocalContextGraphStore } from "./local-context-graph-store.js";
import type { ContextPack } from "./context-pack.js";
import {
  buildReadSideContentScanLabel,
  type ReadSideContentScanLabel,
} from "../tools/read-side-content-scan.js";
import { recordPromptContentScan } from "./prompt-scan-journal.js";
import { renderContextPacks, validateContextPack } from "./context-pack.js";
import { planContextCapacity } from "./context-capacity-planner.js";
import {
  resolveContextPhaseBudget,
  type ContextPhase,
  type ContextPhasePolicy,
} from "./context-phase-policy.js";
import {
  rankOptionalContextCandidates,
  type OptionalContextScorer,
} from "./context-optional-scorer.js";
import { estimateGlobalDecisionTokenCount } from "./global-decision-store.js";

/** 系统规则文本（独立于可选全局记录，任何预算下都进入提示词）。 */
export const APPLICATION_CONTEXT_SYSTEM_RULES = [
  "只执行分配的任务，不得扩大范围或静默放弃。",
  "工具副作用与敏感操作由本地确定性策略裁决；模型声明不能成为授权依据。",
  "完成必须给出当前仓库合法的版本化完成控制事件，由本地门禁结案。",
].join("\n");

import {
  type PendingAssemblyMessage,
  groupMessagesForAssembly,
} from "./comm-message-routing-decisions.js";

export interface NecessaryContextCondition {
  conditionIdentifier: string;
  description: string;
  isSatisfied: boolean;
}

export interface ContextPromptGlobalDecision {
  globalDecisionIdentifier: string;
  decisionSummary: string;
  keyRationale: string;
}

export interface ContextPromptFrontierNode {
  contextNodeIdentifier: string;
  state: string;
  contentFingerprint: string;
}

export interface ContextPromptActiveFrontier {
  graphIdentifier: string;
  revision: number;
  activeNodes: ContextPromptFrontierNode[];
  excludedClosedNodeCount: number;
}

export interface AssembleContextPromptInput {
  systemRulesText: string;
  necessaryConditions: NecessaryContextCondition[];
  globalDecisionRecords: ContextPromptGlobalDecision[];
  activeFrontier: ContextPromptActiveFrontier | null;
  /** 上游插入任务时声明的上下文包（可选；缺省不注入该区块）。 */
  contextPacks?: ReadonlyArray<ContextPack>;
  /**
   * ALIGN-04-05（2026-11-10）：**按节点回访的已关闭上下文**（可选）。
   *
   * 由 `recallClosedContext` 的结果转换而来；**缺省不注入该区块**（旧行为不变）。
   * 每个块必须带节点标识与来源 revision —— 没有来源的文本一律不注入，
   * 避免"看起来像历史但无法追溯"的内容进入提示词。
   */
  recalledContextBlocks?: ReadonlyArray<{
    readonly contextNodeIdentifier: string;
    readonly sourceRevision: number;
    readonly text: string;
  }>;
  /**
   * COMM-01（2026-11-14 用户裁决第 3 条）：**协调消息分区**。
   *
   * 同一 agent 会收到分属不同任务意图的消息序列，序列可能被其它内容打断。
   * 装配时按"同任务 + 同序列"分块；未确认同一事实的消息单列，**不并入合并块**。
   * 缺省不注入该区块 ⇒ 旧行为不变。
   */
  /** COMM-01：可选协调消息。 */
  coordinationMessages?: ReadonlyArray<PendingAssemblyMessage>;
  /** P3：最终提示词硬上限（token 估算）；超限 fail-closed，不静默截断。 */
  maximumPromptTokenCount?: number | undefined;
  /** 可注入的 token 估算器；缺省按字符/4 的保守估算。 */
  countPromptTokens?: ((text: string) => number) | undefined;
}

export interface AssembledContextPrompt {
  promptText: string;
  /**
   * R14（2026-10-29）：**注入侧扫描标注**（只标注、不阻断）。
   * 由 `buildReadSideContentScanLabel` 在装配完成时计算；旧调用方忽略即可。
   */
  contentScan?: ReadSideContentScanLabel;
  injectedGlobalDecisionIdentifiers: string[];
  injectedFrontierNodeIdentifiers: string[];
  excludedClosedNodeCount: number;
  unsatisfiedNecessaryConditionIdentifiers: string[];
  /** 实际注入的上下文包标识（原子包整包注入）。 */
  injectedContextPackIdentifiers?: string[];
  /** ALIGN-04-05：实际注入的回访节点标识（缺省区块不注入 ⇒ 空数组）。 */
  injectedRecalledContextNodeIdentifiers?: string[];
  /** COMM-01：实际注入协调消息的标识（按装配顺序；缺省区块不注入 ⇒ 空数组）。 */
  injectedCoordinationMessageIdentifiers?: string[];
  /** COMM-01：未确认同一事实、单独列出的协调消息标识。 */
  unmergedCoordinationMessageIdentifiers?: string[];
  /** P3：本次装配的保守 token 估算。 */
  estimatedPromptTokenCount?: number;
}

export function assembleContextPrompt(
  input: AssembleContextPromptInput,
): AssembledContextPrompt {
  const unsatisfiedNecessaryConditionIdentifiers = input.necessaryConditions
    .filter((condition) => !condition.isSatisfied)
    .map((condition) => condition.conditionIdentifier);
  const lines: string[] = ["[系统规则]", input.systemRulesText.trim(), "", "[任务必要条件]"];
  if (input.necessaryConditions.length === 0) {
    lines.push("- （无额外必要条件）");
  }
  for (const condition of input.necessaryConditions) {
    lines.push(
      "- " +
        condition.conditionIdentifier +
        ": " +
        condition.description +
        (condition.isSatisfied ? "" : "（缺失）"),
    );
  }
  lines.push("", "[全局相关决策]");
  const injectedGlobalDecisionIdentifiers: string[] = [];
  for (const record of input.globalDecisionRecords) {
    lines.push(
      "- " +
        record.globalDecisionIdentifier +
        ": " +
        record.decisionSummary +
        "（理由：" +
        record.keyRationale +
        "）",
    );
    injectedGlobalDecisionIdentifiers.push(record.globalDecisionIdentifier);
  }
  if (input.globalDecisionRecords.length === 0) {
    lines.push("- （无相关全局决策注入）");
  }
  lines.push("", "[局部活跃前沿]");
  const injectedFrontierNodeIdentifiers: string[] = [];
  if (input.activeFrontier === null) {
    lines.push("- （无局部上下文图）");
  } else {
    for (const node of input.activeFrontier.activeNodes) {
      lines.push(
        "- " +
          node.contextNodeIdentifier +
          " [" +
          node.state +
          "] fp=" +
          node.contentFingerprint.slice(0, 12),
      );
      injectedFrontierNodeIdentifiers.push(node.contextNodeIdentifier);
    }
    lines.push(
      "- （已关闭节点 " +
        input.activeFrontier.excludedClosedNodeCount +
        " 个：只计数，不注入原文）",
    );
  }
  lines.push("", "[上下文包]");
  const contextPacks = input.contextPacks ?? [];
  const invalidPackIdentifiers = contextPacks
    .filter((pack) => validateContextPack(pack).length > 0)
    .map((pack) => pack.packIdentifier);
  const renderedPacks = renderContextPacks(contextPacks);
  for (const line of renderedPacks.lines) lines.push(line);
  if (invalidPackIdentifiers.length > 0) {
    lines.push(
      "- （拒绝注入的非法上下文包：" + invalidPackIdentifiers.join("、") + "）",
    );
  }

  /**
   * ALIGN-04-05（2026-11-10）：**按节点回访区块**。
   *
   * 只接受**带来源**的块（节点标识 + revision）；没有来源的文本不注入，
   * 且明确标注"这是该节点的已关闭摘要，不是完整历史"，防止被当成全局记忆。
   */
  const injectedRecalledContextNodeIdentifiers: string[] = [];
  const recalledBlocks = input.recalledContextBlocks ?? [];
  const usableRecalledBlocks = recalledBlocks.filter(
    (block) => block.contextNodeIdentifier.trim() !== "" && block.text.trim() !== "",
  );
  if (usableRecalledBlocks.length > 0) {
    lines.push("", "[按节点回访的已关闭上下文]");
    lines.push("（以下仅为所列节点的关闭摘要，不是完整历史，也不含其他节点内容。）");
    for (const block of usableRecalledBlocks) {
      lines.push(
        `- 节点 ${block.contextNodeIdentifier}（revision ${block.sourceRevision}）: ${block.text.trim()}`,
      );
      injectedRecalledContextNodeIdentifiers.push(block.contextNodeIdentifier);
    }
  }

  /**
   * COMM-01（2026-11-14 用户裁决第 3 条）：**协调消息分区渲染**。
   *
   * 分组依据"同任务 + 同序列"，**不依赖相邻性**（序列可被其它内容打断）；
   * 未确认同一事实的消息单列在「[未确认同一事实]」下，绝不并入合并块。
   */
  const injectedCoordinationMessageIdentifiers: string[] = [];
  const unmergedCoordinationMessageIdentifiers: string[] = [];
  if (
    input.coordinationMessages !== undefined &&
    input.coordinationMessages.length > 0
  ) {
    const assembly = groupMessagesForAssembly(input.coordinationMessages);
    lines.push("", "[协调消息]");
    for (const group of assembly.groups) {
      lines.push(
        `- [任务 ${group.sourceTaskIdentifier} / 序列 ${group.sequenceIdentifier}]`,
      );
      for (const messageIdentifier of group.messageIdentifiers) {
        injectedCoordinationMessageIdentifiers.push(messageIdentifier);
      }
      for (const messageText of group.combinedText.split("\n")) {
        lines.push(`  - ${messageText}`);
      }
    }
    if (assembly.unmergedMessageIdentifiers.length > 0) {
      lines.push("", "[未确认同一事实]");
      for (const message of input.coordinationMessages) {
        if (!assembly.unmergedMessageIdentifiers.includes(message.messageIdentifier)) {
          continue;
        }
        unmergedCoordinationMessageIdentifiers.push(message.messageIdentifier);
        lines.push(
          `- [任务 ${message.sourceTaskIdentifier} / 序列 ${message.sequenceIdentifier}] ${message.text}`,
        );
      }
    }
  }

  const promptText = lines.join("\n");
  const countPromptTokens =
    input.countPromptTokens ??
    ((text: string): number => {
      let codePoints = 0;
      for (const character of text) {
        void character;
        codePoints += 1;
      }
      return Math.ceil(codePoints / 4);
    });
  const estimatedPromptTokenCount = countPromptTokens(promptText);
  if (input.maximumPromptTokenCount !== undefined) {
    if (
      !Number.isInteger(input.maximumPromptTokenCount) ||
      input.maximumPromptTokenCount < 0
    ) {
      throw new DomainError(
        "context-budget-invalid",
        "maximumPromptTokenCount must be a non-negative integer",
      );
    }
    if (estimatedPromptTokenCount > input.maximumPromptTokenCount) {
      throw new DomainError(
        "context-budget-insufficient",
        "上下文提示词超过硬上限，不能静默截断；请拆分任务或缩小注入范围" +
          `（estimated=${estimatedPromptTokenCount}, budget=${input.maximumPromptTokenCount}）`,
      );
    }
  }
  return {
    promptText,
    estimatedPromptTokenCount,
    /**
     * SEC-02 通道 12 / R14（2026-10-29）：**注入侧扫描标注**。
     *
     * 只标注（结论/规则版本/时间），**不改内容、不阻断**；调用方可用它决定是否注入。
     */
    contentScan: buildReadSideContentScanLabel(promptText),
    injectedGlobalDecisionIdentifiers,
    injectedFrontierNodeIdentifiers,
    excludedClosedNodeCount: input.activeFrontier?.excludedClosedNodeCount ?? 0,
    unsatisfiedNecessaryConditionIdentifiers,
    injectedContextPackIdentifiers: renderedPacks.injectedPackIdentifiers.slice(),
    injectedRecalledContextNodeIdentifiers,
    injectedCoordinationMessageIdentifiers,
    unmergedCoordinationMessageIdentifiers,
  };
}

export interface ContextPromptProviderInput {
  missionId: string;
  agentInstanceId: string;
  task: TaskDependencyNode;
  /** P4：当前所处阶段；缺省由 provider 配置或 execution 决定。 */
  phase?: ContextPhase;
}

export type ContextPromptProvider = (
  input: ContextPromptProviderInput,
) => Promise<AssembledContextPrompt>;

export interface ContextPromptProviderOptions {
  globalDecisionStore: GlobalDecisionStore;
  graphStore: LocalContextGraphStore;
  maximumGlobalContextTokenCount: number;
  mandatoryConditions?: NecessaryContextCondition[];
  /** T09A-R1-02：预算策略提供者（设置变化通过 revision 使选择缓存失效）。 */
  budgetPolicyProvider?: (input: ContextPromptProviderInput) => Promise<{
    configuredMaximumGlobalContextTokenCount: number;
    globalContextBudgetPolicyRevision: number;
  }>;
  /** T09A-R1-02：Provider 可用输入空间（token）；配置超出时取较小有效值。 */
  modelInputSpaceTokens?: number | null;
  /** P1：系统规则、当前任务、工具说明、协议与输出预留的 token 总量。 */
  reservedInputTokens?: number | undefined;
  /** P3：最终装配提示词的硬上限；缺省不启用。 */
  maximumPromptTokenCount?: number | undefined;
  /** P4：默认阶段与阶段策略。 */
  contextPhase?: ContextPhase | undefined;
  contextPhasePolicy?: ContextPhasePolicy | undefined;
  /** P6：未注入候选的延后/回访排序评分器；不得影响 required 选择。 */
  optionalContextScorer?: OptionalContextScorer | undefined;
  /** P2：未进入提示词的全局决策写入按 Agent/任务隔离的延后上下文。 */
  deferredContextWriter?: (
    input: {
      readonly missionId: string;
      readonly agentInstanceId: string;
      readonly task: TaskDependencyNode;
      readonly decisions: readonly GlobalDecisionRecord[];
    },
  ) => Promise<void> | void;
  /** T09A-R1-04：真实装配事件接收器（原始事件 → 指标复算）。 */
  runtimeEventSink?: ((event: ContextAssemblyRuntimeEvent) => void | Promise<void>) | null;
  /** T09A-R1-04：时钟（测试可注入）。 */
  nowIso?: () => string;
}

export interface ContextBudgetResolution {
  configuredMaximumGlobalContextTokenCount: number;
  effectiveMaximumGlobalContextTokenCount: number;
  budgetPolicyRevision: number;
  budgetReductionReason: string | null;
}

/** 计算配置值、有效值与缩减原因（模型空间不足时缩减，不报错）。 */
export function resolveContextBudget(input: {
  configuredMaximumGlobalContextTokenCount: number;
  budgetPolicyRevision: number;
  modelInputSpaceTokens?: number | null;
  /** Tokens already reserved for system rules, task, tools, protocol and output. */
  reservedInputTokens?: number | undefined;
}): ContextBudgetResolution {
  const capacity = planContextCapacity({
    configuredHistoryTokenCount: input.configuredMaximumGlobalContextTokenCount,
    modelInputSpaceTokens: input.modelInputSpaceTokens,
    reservedInputTokens: input.reservedInputTokens ?? 0,
  });
  return {
    configuredMaximumGlobalContextTokenCount: capacity.configuredHistoryTokenCount,
    effectiveMaximumGlobalContextTokenCount: capacity.effectiveHistoryTokenCount,
    budgetPolicyRevision: input.budgetPolicyRevision,
    budgetReductionReason: capacity.budgetReductionReason,
  };
}

/** 由真实存储构建提示词装配提供者（全局选择 + 局部活跃前沿）。 */
export function createContextPromptProvider(
  options: ContextPromptProviderOptions,
): ContextPromptProvider {
  const selectionCache = new Map<string, ReturnType<typeof selectGlobalDecisionsForTask>>();
  const lastKeyPartsByScope = new Map<
    string,
    { budgetPolicyRevision: number; effectiveBudgetTokens: number; recordsFingerprint: string }
  >();
  return async (input) => {
    const policy =
      options.budgetPolicyProvider === undefined
        ? null
        : await options.budgetPolicyProvider(input);
    const budget = resolveContextBudget({
      configuredMaximumGlobalContextTokenCount:
        policy?.configuredMaximumGlobalContextTokenCount ??
        options.maximumGlobalContextTokenCount,
      budgetPolicyRevision: policy?.globalContextBudgetPolicyRevision ?? 0,
      modelInputSpaceTokens: options.modelInputSpaceTokens,
      reservedInputTokens: options.reservedInputTokens,
    });
    const phase = input.phase ?? options.contextPhase ?? "execution";
    const phaseBudget = resolveContextPhaseBudget({
      phase,
      configuredHistoryTokenCount: budget.effectiveMaximumGlobalContextTokenCount,
      maximumPromptTokenCount: options.maximumPromptTokenCount,
      policy: options.contextPhasePolicy,
    });
    const effectiveHistoryTokenCount = phaseBudget.historyTokenCount;
    const effectivePromptTokenLimit = phaseBudget.maximumPromptTokenCount ?? undefined;
    const records = await options.globalDecisionStore.listRecords();
    const recordsFingerprint = records
      .map((record) => record.globalDecisionIdentifier + ":" + record.globalContextRevision)
      .join(",");
    const cacheKey = [
      input.missionId,
      input.agentInstanceId,
      input.task.id,
      phase,
      String(budget.budgetPolicyRevision),
      String(effectiveHistoryTokenCount),
      recordsFingerprint,
    ].join("|");
    const scopeKey = input.missionId + "|" + input.agentInstanceId + "|" + input.task.id;
    const previousKeyParts = lastKeyPartsByScope.get(scopeKey);
    lastKeyPartsByScope.set(scopeKey, {
      budgetPolicyRevision: budget.budgetPolicyRevision,
      effectiveBudgetTokens: effectiveHistoryTokenCount,
      recordsFingerprint,
    });
    let selection = selectionCache.get(cacheKey);
    const cacheStatus: "hit" | "miss" = selection === undefined ? "miss" : "hit";
    let invalidationReason: string | null = null;
    if (selection === undefined && previousKeyParts !== undefined) {
      if (previousKeyParts.budgetPolicyRevision !== budget.budgetPolicyRevision) {
        invalidationReason = "budget-policy-revision-change";
      } else if (previousKeyParts.effectiveBudgetTokens !== effectiveHistoryTokenCount) {
        invalidationReason = "effective-budget-change";
      } else if (previousKeyParts.recordsFingerprint !== recordsFingerprint) {
        invalidationReason = "global-records-change";
      }
    }
    if (selection === undefined) {
      selection = selectGlobalDecisionsForTask({
        relation: {
          taskIdentifier: input.task.id,
          missionId: input.missionId,
          scopeKeys: [input.missionId, input.task.id],
        },
        records,
        maximumGlobalContextTokenCount: effectiveHistoryTokenCount,
      });
      selectionCache.set(cacheKey, selection);
    }
    if (
      effectiveHistoryTokenCount > 0 &&
      selection.unselectedRelatedDecisions.length > 0 &&
      options.deferredContextWriter !== undefined
    ) {
      const candidates = selection.unselectedRelatedDecisions.flatMap((record) => {
        const category = selection.selectionReasonsByIdentifier[
          record.globalDecisionIdentifier
        ];
        return category === undefined
          ? []
          : [{
              record,
              category,
              estimatedTokenCount: estimateGlobalDecisionTokenCount(record),
              phase,
            }];
      });
      const ranked = rankOptionalContextCandidates(
        candidates,
        options.optionalContextScorer,
      );
      await options.deferredContextWriter({
        missionId: input.missionId,
        agentInstanceId: input.agentInstanceId,
        task: input.task,
        decisions: ranked.map((candidate) => candidate.record),
      });
    }
    if (effectiveHistoryTokenCount > 0 && selection.budgetInsufficient) {
      throw new DomainError(
        "context-budget-insufficient",
        "最高优先级全局决策无法在有效预算内装入；请拆分任务或提高全局上下文预算" +
          `（task=${input.task.id}, phase=${phase}, budget=${effectiveHistoryTokenCount}` +
          `, unmet=${selection.highestPriorityUnmetTokenCount ?? "unknown"}）`,
      );
    }
    const graph = await options.graphStore.readGraph(
      input.agentInstanceId,
      input.missionId,
    );
    const frontier = graph === null ? null : buildPromptActiveFrontier(graph);
    const runtimeEventSink = options.runtimeEventSink ?? null;
    const emitRuntimeEvent = (assembled: AssembledContextPrompt): void => {
      if (runtimeEventSink === null) {
        return;
      }
      const event: ContextAssemblyRuntimeEvent = {
        schemaVersion: 1,
        eventType: "context-assembly",
        recordedAtIso: options.nowIso?.() ?? new Date().toISOString(),
        missionId: input.missionId,
        agentInstanceId: input.agentInstanceId,
        taskIdentifier: input.task.id,
        cacheStatus,
        invalidationReason,
        injectedGlobalDecisionCount: assembled.injectedGlobalDecisionIdentifiers.length,
        injectedFrontierNodeCount: assembled.injectedFrontierNodeIdentifiers.length,
        excludedClosedNodeCount: assembled.excludedClosedNodeCount,
        estimatedInjectedTokenCount: estimateRecallTokenCount(assembled.promptText),
        budgetPolicyRevision: budget.budgetPolicyRevision,
        effectiveBudgetTokens: effectiveHistoryTokenCount,
      };
      void Promise.resolve(runtimeEventSink(event)).catch(() => {});
    };
    const assembled = assembleContextPrompt({
      systemRulesText: APPLICATION_CONTEXT_SYSTEM_RULES,
      necessaryConditions: options.mandatoryConditions ?? [],
      globalDecisionRecords: selection.selected.map((record) => ({
        globalDecisionIdentifier: record.globalDecisionIdentifier,
        decisionSummary: record.decisionSummary,
        keyRationale: record.keyRationale,
      })),
      activeFrontier:
        frontier === null
          ? null
          : {
              graphIdentifier: frontier.graphIdentifier,
              revision: frontier.revision,
              activeNodes: frontier.activeNodes.map((node) => ({
                contextNodeIdentifier: node.contextNodeIdentifier,
                state: node.state,
                contentFingerprint: node.contentFingerprint,
              })),
              excludedClosedNodeCount: frontier.excludedClosedNodeCount,
            },
      maximumPromptTokenCount: effectivePromptTokenLimit,
    });
    emitRuntimeEvent(assembled);
    /**
     * R15（2026-10-29）：**消费装配标注** —— 写一条有界运行记录（只含结论，不含正文）。
     *
     * 不阻断、不改内容；记录失败不影响装配（诊断不能成为装配的单点故障）。
     */
    if (assembled.contentScan !== undefined) {
      try {
        recordPromptContentScan({
          missionIdentifier: input.missionId,
          agentInstanceIdentifier: input.agentInstanceId,
          taskIdentifier: input.task.id,
          outcome: assembled.contentScan.outcome,
          ruleSetVersion: assembled.contentScan.ruleSetVersion,
          matchedRuleIdentifiers: assembled.contentScan.matchedRuleIdentifiers,
          limitReason: assembled.contentScan.limitReason,
          isClean: assembled.contentScan.isClean,
          recordedAtIso: assembled.contentScan.evaluatedAtIso,
        });
      } catch {
        // 诊断记录失败不影响装配结果
      }
    }
    return assembled;
  };
}

