/**
 * ALIGN-01-03（2026-10-28）：主 Agent 任务提案的**本地解析与提交契约**。
 *
 * 背景：主 Agent 只能做"交流 + 高层评估"，它**没有**写盘、spawn、执行或授权工具；
 * 它表达"要做什么"的唯一通道是**结构化提案**，由本地控制面校验后写入任务序列。
 * 既有控制面已存在（`ConversationTaskInsertionController`，T08A/ADR-0022），
 * 本模块只补三件事，且都在**本地**完成（不依赖模型自觉）：
 *
 * 1. **严格白名单解析**：模型给出的 JSON 只允许本文件列出的字段；多一个字段就拒绝。
 *    —— 模型不能借"多写一个字段"塞进 `sourceKind`、`approvedBy`、`permission` 等。
 * 2. **harness 注入的身份**：提案来源永远是 `agent`、来源个体由装配层注入、
 *    认证用户由宿主提供；模型即使伪造也只会被拒绝（`FORBIDDEN_PROPOSAL_FIELDS`）。
 * 3. **必须引用用户原始任务**：提案里的 `userTaskReference` 必须**等于**本次
 *    用户消息的引用（harness 注入），不能凭空发明一个"用户任务"。
 *
 * 本模块**不是**主 Agent 可调用的工具：它只被本地控制面（`MainController`
 * 的提案入口）调用。工具投影侧另有 `MainAgentReadonlyToolProjection` 保证
 * 主 Agent 在全部模式下只有只读工具。
 *
 * 未接入：`requiredArtifactIdentifiers`（所需产物）属于 ALIGN-01-04，
 * 目前**不在白名单内** ⇒ 模型提交该字段会收到"不支持的字段"，不会静默丢弃。
 */
import { randomUUID } from "node:crypto";

import { DomainError } from "../core/errors.js";
import type {
  ConversationTaskInsertionController,
  TaskInsertionProposal,
} from "./conversation-task-insertion-controller.js";

/** ALIGN-01-03 允许模型填写的提案字段（严格白名单）。 */
export const MAIN_AGENT_TASK_PROPOSAL_ALLOWED_FIELDS = [
  "targetSecondaryAgentInstanceIdentifier",
  "sequenceIdentifier",
  "expectedRevision",
  "title",
  "acceptanceCriteria",
  "predecessorTaskIdentifiers",
  "successorTaskIdentifiers",
  "userTaskReference",
  "priorityTier",
] as const;

/**
 * 一旦出现即视为"模型试图自填身份/授权"的字段。
 *
 * 这些字段**由 harness 注入**；模型填写它们不是"多余字段"，而是越权尝试，
 * 因此单独给出权限类错误码，而不是笼统的格式错误。
 */
export const FORBIDDEN_MAIN_AGENT_TASK_PROPOSAL_FIELDS = [
  "sourceKind",
  "sourceActorId",
  "sourceActorIdentifier",
  "authenticatedUserId",
  "approvedBy",
  "approval",
  "authorization",
  "isApproved",
  "permission",
  "permissions",
  "userDecisionReference",
  "signature",
  "token",
] as const;

export interface MainAgentTaskProposal {
  readonly targetSecondaryAgentInstanceIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly expectedRevision: number;
  readonly title: string;
  readonly acceptanceCriteria: string;
  readonly predecessorTaskIdentifiers: readonly string[];
  readonly successorTaskIdentifiers: readonly string[];
  readonly userTaskReference: string;
  /** 缺省 null ⇒ 由本地优先级策略按来源（agent）决定；显式值必须 ≥ 1。 */
  readonly priorityTier: number | null;
}

export interface MainAgentTaskProposalSubmissionContext {
  /** 具体主 Agent 个体（装配层注入；模型不可填）。 */
  readonly sourceActorIdentifier: string;
  /** 认证用户（宿主注入；无认证 ⇒ null）。 */
  readonly authenticatedUserId: string | null;
  /** 本次用户消息的引用（harness 注入）；提案必须引用它。 */
  readonly originalUserTaskReference: string;
  readonly conversationIdentifier: string | null;
}

export interface MainAgentTaskProposalSubmissionResult {
  readonly proposalIdentifier: string;
  readonly targetSecondaryAgentInstanceIdentifier: string;
  readonly sequenceIdentifier: string;
  readonly expectedRevision: number;
  readonly conversationIdentifier: string | null;
}

export interface MainAgentTaskProposalContractOptions {
  readonly nowIso?: () => string;
  readonly generateProposalIdentifier?: () => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  record: Record<string, unknown>,
  fieldName: string,
): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "invalid-task-chain",
      `提案字段 ${fieldName} 必须是非空字符串。`,
    );
  }
  return value.trim();
}

function readStringArray(
  record: Record<string, unknown>,
  fieldName: string,
): string[] {
  const value = record[fieldName];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DomainError(
      "invalid-task-chain",
      `提案字段 ${fieldName} 必须是字符串数组。`,
    );
  }
  return value.map((entry) => (entry as string).trim()).filter((entry) => entry !== "");
}

export class MainAgentTaskProposalContract {
  private readonly nowIso: () => string;
  private readonly generateProposalIdentifier: () => string;

  constructor(options: MainAgentTaskProposalContractOptions = {}) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.generateProposalIdentifier =
      options.generateProposalIdentifier ?? (() => `proposal-${randomUUID()}`);
  }

  /**
   * 解析模型输出。**不信任任何模型给的来源/授权字段**。
   *
   * 失败方向刻意"宁可拒绝"：多字段、少字段、类型不对、层级越权都是明确错误，
   * 不做"尽力猜测"式的部分接受。
   */
  parse(payload: unknown): MainAgentTaskProposal {
    if (!isPlainObject(payload)) {
      throw new DomainError("invalid-task-chain", "提案必须是 JSON 对象。");
    }
    const forbiddenFields = FORBIDDEN_MAIN_AGENT_TASK_PROPOSAL_FIELDS.filter(
      (fieldName) => payload[fieldName] !== undefined,
    );
    if (forbiddenFields.length > 0) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `模型不得自行填写身份/授权字段（由本地注入）: ${forbiddenFields.join(", ")}`,
      );
    }
    const allowedFieldNames = new Set<string>(MAIN_AGENT_TASK_PROPOSAL_ALLOWED_FIELDS);
    const unknownFields = Object.keys(payload).filter(
      (fieldName) => !allowedFieldNames.has(fieldName),
    );
    if (unknownFields.length > 0) {
      throw new DomainError(
        "invalid-task-chain",
        `提案包含不支持的字段（不得静默忽略）: ${unknownFields.join(", ")}`,
      );
    }

    const expectedRevisionValue = payload.expectedRevision;
    if (
      typeof expectedRevisionValue !== "number" ||
      !Number.isInteger(expectedRevisionValue) ||
      expectedRevisionValue < 0
    ) {
      throw new DomainError(
        "invalid-task-chain",
        "提案字段 expectedRevision 必须是 ≥ 0 的整数（观察到的任务序列 revision）。",
      );
    }
    const priorityTierValue = payload.priorityTier;
    if (
      priorityTierValue !== undefined &&
      (typeof priorityTierValue !== "number" ||
        !Number.isInteger(priorityTierValue) ||
        priorityTierValue < 1)
    ) {
      throw new DomainError(
        "task-priority-denied",
        "主 Agent 派生任务只能进入层级 ≥ 1（不得伪装用户层级 0）。",
      );
    }

    const predecessorTaskIdentifiers = readStringArray(
      payload,
      "predecessorTaskIdentifiers",
    );
    const successorTaskIdentifiers = readStringArray(
      payload,
      "successorTaskIdentifiers",
    );
    const overlap = predecessorTaskIdentifiers.filter((taskIdentifier) =>
      successorTaskIdentifiers.includes(taskIdentifier),
    );
    if (overlap.length > 0) {
      throw new DomainError(
        "invalid-task-chain",
        `同一任务不能同时是前驱与后继: ${overlap.join(", ")}`,
      );
    }

    return {
      targetSecondaryAgentInstanceIdentifier: readRequiredString(
        payload,
        "targetSecondaryAgentInstanceIdentifier",
      ),
      sequenceIdentifier: readRequiredString(payload, "sequenceIdentifier"),
      expectedRevision: expectedRevisionValue,
      title: readRequiredString(payload, "title"),
      acceptanceCriteria: readRequiredString(payload, "acceptanceCriteria"),
      predecessorTaskIdentifiers,
      successorTaskIdentifiers,
      userTaskReference: readRequiredString(payload, "userTaskReference"),
      priorityTier: priorityTierValue === undefined ? null : priorityTierValue,
    };
  }

  /**
   * 校验并提交到**既有本地提案控制面**（`ConversationTaskInsertionController`）。
   *
   * 本方法只做"本地可信上下文 + 模型字段"的合并与一致性检查；
   * revision、锚点、优先级与来源规则仍由既有控制面/任务序列层判定（不重复实现）。
   */
  async submit(
    payload: unknown,
    context: MainAgentTaskProposalSubmissionContext,
    insertionController: ConversationTaskInsertionController,
  ): Promise<MainAgentTaskProposalSubmissionResult> {
    const proposal = this.parse(payload);
    if (context.sourceActorIdentifier.trim() === "") {
      throw new DomainError(
        "task-sequence-permission-denied",
        "主 Agent 提案必须绑定具体个体（来源个体由装配层注入，不得为空）。",
      );
    }
    if (context.originalUserTaskReference.trim() === "") {
      throw new DomainError(
        "invalid-task-chain",
        "提案必须引用一次用户原始任务；当前没有可引用的用户消息。",
      );
    }
    if (proposal.userTaskReference !== context.originalUserTaskReference) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `提案引用的用户任务与本次用户消息不一致（不得凭空发明用户来源）：${proposal.userTaskReference}`,
      );
    }
    const targetSecondaryAgentInstanceId =
      proposal.targetSecondaryAgentInstanceIdentifier;
    if (targetSecondaryAgentInstanceId === context.sourceActorIdentifier) {
      throw new DomainError(
        "task-sequence-permission-denied",
        "主 Agent 不能把任务提案投给自己（必须指向次级个体）。",
      );
    }

    const proposalIdentifier = this.generateProposalIdentifier();
    const insertionProposal: TaskInsertionProposal = {
      proposalId: proposalIdentifier,
      targetSecondaryAgentInstanceId,
      sequenceId: proposal.sequenceIdentifier,
      expectedRevision: proposal.expectedRevision,
      /** 来源与来源个体**恒由 harness 注入**，不使用模型提供的任何字段。 */
      sourceKind: "agent",
      sourceActorId: context.sourceActorIdentifier,
      task: {
        taskId: `task-${proposalIdentifier}`,
        title: proposal.title,
        priorityTier: proposal.priorityTier,
        externalReference: `user-task:${context.originalUserTaskReference}`,
      },
      anchor: {
        predecessorTaskIds: [...proposal.predecessorTaskIdentifiers],
        successorTaskIds: [...proposal.successorTaskIdentifiers],
      },
      acceptanceCriteria: proposal.acceptanceCriteria,
      createdAtIso: this.nowIso(),
    };
    await insertionController.submitProposal(insertionProposal);
    return {
      proposalIdentifier,
      targetSecondaryAgentInstanceIdentifier: targetSecondaryAgentInstanceId,
      sequenceIdentifier: proposal.sequenceIdentifier,
      expectedRevision: proposal.expectedRevision,
      conversationIdentifier: context.conversationIdentifier,
    };
  }
}
