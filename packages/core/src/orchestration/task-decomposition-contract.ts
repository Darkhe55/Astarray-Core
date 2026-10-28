/**
 * ALIGN-02-02（2026-10-28）：任务分解的**本地校验契约**。
 *
 * 卡内要求：默认执行不再用固定 T-001 代替全部规划；次级读取任务目标与必要项目摘要，
 * 形成**有依赖**的执行节点及**验收要求**；已有分解直接复用；模型建议必须经
 * **本地 schema、循环与优先级校验**后提交，且**不能伪造用户最高优先来源**。
 *
 * 本模块只做"把候选分解变成可信任务节点"这一段（纯函数、确定性）：
 * - 模型输出先按**严格白名单**解析（多字段即拒绝，避免塞入 `sourceKind`/`priorityTier`
 *   这类权威字段）；
 * - 校验：节点数有界、标识唯一且合法、描述与验收条件非空、依赖存在且无环、工具子集合法；
 * - 产出的节点恒为 `pending`、`assignedAgentId: null`、`taskType: "data"` ——
 *   **来源与优先级不由候选稿决定**（分解节点是次级派生的执行节点，不是用户层任务）。
 *
 * 单节点兜底（`buildSingleNodeDecomposition`）保留旧行为，但只作为**显式降级**：
 * 调用方必须记录"这是降级而非规划"，不得把它当成规划结果。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type { TaskDependencyNode } from "../core/types.js";

/** 单次分解允许的节点上限（超过多半是模型把任务清单当正文写）。 */
export const MAXIMUM_DECOMPOSED_TASK_COUNT = 12;

/** 节点标识允许的形态（不含 `:`，避免与个体/会话命名空间混淆）。 */
const TASK_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

/** 模型稿允许出现的字段（严格白名单；多一个就拒绝）。 */
const ALLOWED_DRAFT_NODE_FIELDS = [
  "id",
  "description",
  "dependsOn",
  "acceptanceCriteria",
  "toolNames",
] as const;

export interface TaskDecompositionValidationInput {
  /** 模型/上游给出的候选稿（不可信）。 */
  readonly draft: unknown;
  /** 可用工具名全集（节点声明的工具必须在此集合内）。 */
  readonly availableToolNames: readonly string[];
}

/**
 * 解析并校验候选分解，返回可写入任务链的节点。
 *
 * 失败一律 `task-decomposition-invalid`，不做"尽量修一修"的部分接受。
 */
export function parseAndValidateTaskDecomposition(
  input: TaskDecompositionValidationInput,
): TaskDependencyNode[] {
  const rawNodes = readCandidateNodes(input.draft);
  if (rawNodes.length === 0) {
    throw new DomainError("task-decomposition-invalid", "分解结果为空：至少需要一个执行节点。");
  }
  if (rawNodes.length > MAXIMUM_DECOMPOSED_TASK_COUNT) {
    throw new DomainError(
      "task-decomposition-invalid",
      `分解节点过多（${rawNodes.length} > ${MAXIMUM_DECOMPOSED_TASK_COUNT}）：请合并无独立验收意义的节点。`,
    );
  }

  const nodeIdentifiers = new Set<string>();
  for (const rawNode of rawNodes) {
    if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) {
      throw new DomainError("task-decomposition-invalid", "分解节点必须是 JSON 对象。");
    }
    const record = rawNode as Record<string, unknown>;
    const unknownFields = Object.keys(record).filter(
      (fieldName) => !(ALLOWED_DRAFT_NODE_FIELDS as readonly string[]).includes(fieldName),
    );
    if (unknownFields.length > 0) {
      throw new DomainError(
        "task-decomposition-invalid",
        `分解节点包含不支持的字段（不得静默忽略）: ${unknownFields.join(", ")}`,
      );
    }
    const nodeIdentifier = readRequiredString(record, "id", "节点 id");
    if (!TASK_IDENTIFIER_PATTERN.test(nodeIdentifier)) {
      throw new DomainError(
        "task-decomposition-invalid",
        `节点 id 非法（只允许字母/数字/._-）: ${nodeIdentifier}`,
      );
    }
    if (nodeIdentifiers.has(nodeIdentifier)) {
      throw new DomainError("task-decomposition-invalid", `节点 id 重复: ${nodeIdentifier}`);
    }
    nodeIdentifiers.add(nodeIdentifier);
  }

  const nodes: TaskDependencyNode[] = [];
  for (const rawNode of rawNodes) {
    const record = rawNode as Record<string, unknown>;
    const nodeIdentifier = (record["id"] as string).trim();
    const description = readRequiredString(record, "description", "节点描述");
    const acceptanceCriteria = readRequiredString(
      record,
      "acceptanceCriteria",
      "节点验收要求",
    );
    const dependsOn = readStringArray(record, "dependsOn");
    for (const dependencyIdentifier of dependsOn) {
      if (dependencyIdentifier === nodeIdentifier) {
        throw new DomainError(
          "task-decomposition-invalid",
          `节点不能依赖自身: ${nodeIdentifier}`,
        );
      }
      if (!nodeIdentifiers.has(dependencyIdentifier)) {
        throw new DomainError(
          "task-decomposition-invalid",
          `节点 ${nodeIdentifier} 依赖了不存在的节点: ${dependencyIdentifier}`,
        );
      }
    }
    const toolNames = readStringArray(record, "toolNames");
    const allowedToolNames = new Set(input.availableToolNames);
    const unknownToolNames = toolNames.filter((toolName) => !allowedToolNames.has(toolName));
    if (unknownToolNames.length > 0) {
      throw new DomainError(
        "task-decomposition-invalid",
        `节点 ${nodeIdentifier} 声明了未注册工具: ${unknownToolNames.join(", ")}`,
      );
    }
    nodes.push({
      id: nodeIdentifier,
      description,
      dependsOn,
      taskType: "data",
      /** 缺省授予全部已注册工具（与旧单节点行为一致）；显式声明则只给声明的子集。 */
      toolNames: toolNames.length === 0 ? [...input.availableToolNames] : toolNames,
      assignedAgentId: null,
      status: "pending",
      resultLocation: null,
      /** 执行节点的验收要求随节点走；它不是"已完成"的证明。 */
      acceptanceCriteria,
    });
  }

  assertAcyclic(nodes);
  return nodes;
}

/**
 * 单节点降级（旧行为）。
 *
 * **不是规划**：调用方必须把 `isFallback: true` 记进任务摘要，并在用户可见处
 * 说明本任务没有经过分解，不得把降级说成"已规划"。
 */
export function buildSingleNodeDecomposition(input: {
  readonly instructionText: string;
  readonly availableToolNames: readonly string[];
  readonly fallbackReason: string | null;
}): { nodes: TaskDependencyNode[]; isFallback: true; fallbackReason: string | null } {
  return {
    isFallback: true,
    fallbackReason: input.fallbackReason,
    nodes: [
      {
        id: "T-001",
        description: input.instructionText,
        dependsOn: [],
        taskType: "data",
        toolNames: [...input.availableToolNames],
        assignedAgentId: null,
        status: "pending",
        resultLocation: null,
      },
    ],
  };
}

/**
 * 为任务链补一个**本地生成**的节点标识（仅在候选稿缺 id 时使用）。
 * 不复用 mission/会话命名空间，避免身份混淆。
 */
export function generateTaskNodeIdentifier(): string {
  return `task-node-${randomUUID().slice(0, 8)}`;
}

function readCandidateNodes(draft: unknown): unknown[] {
  if (Array.isArray(draft)) {
    return draft;
  }
  if (typeof draft === "object" && draft !== null) {
    const record = draft as Record<string, unknown>;
    if (Array.isArray(record["nodes"])) {
      return record["nodes"];
    }
  }
  throw new DomainError(
    "task-decomposition-invalid",
    "分解结果必须是 { nodes: [...] } 或节点数组。",
  );
}

function readRequiredString(
  record: Record<string, unknown>,
  fieldName: string,
  label: string,
): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("task-decomposition-invalid", `${label}不能为空（字段 ${fieldName}）。`);
  }
  return value.trim();
}

function readStringArray(record: Record<string, unknown>, fieldName: string): string[] {
  const value = record[fieldName];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DomainError("task-decomposition-invalid", `字段 ${fieldName} 必须是字符串数组。`);
  }
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/** 依赖图无环（DFS 三色标记）；有环时给出**参与环的节点**，不只说"有环"。 */
function assertAcyclic(nodes: readonly TaskDependencyNode[]): void {
  const dependenciesByIdentifier = new Map<string, readonly string[]>();
  for (const node of nodes) {
    dependenciesByIdentifier.set(node.id, node.dependsOn);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const pathStack: string[] = [];

  const visit = (nodeIdentifier: string): void => {
    if (visited.has(nodeIdentifier)) {
      return;
    }
    if (visiting.has(nodeIdentifier)) {
      const cycleStartIndex = pathStack.indexOf(nodeIdentifier);
      const cyclePath = [...pathStack.slice(cycleStartIndex), nodeIdentifier];
      throw new DomainError(
        "task-decomposition-invalid",
        `分解存在依赖环: ${cyclePath.join(" → ")}`,
      );
    }
    visiting.add(nodeIdentifier);
    pathStack.push(nodeIdentifier);
    for (const dependencyIdentifier of dependenciesByIdentifier.get(nodeIdentifier) ?? []) {
      visit(dependencyIdentifier);
    }
    pathStack.pop();
    visiting.delete(nodeIdentifier);
    visited.add(nodeIdentifier);
  };

  for (const node of nodes) {
    visit(node.id);
  }
}
