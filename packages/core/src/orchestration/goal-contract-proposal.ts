/**
 * R73（2026-10-31）：**目标提案与用户确认**（K1）。
 *
 * 卡 01/边界要求：目标是"用户设立"的；**模型只能提议**，不能自定判准、删要求或改来源。
 * 因此拆成两步：
 * 1. `proposeGoalContract`：模型/宿主提交**提案**（不落契约、不绑定、不派发）；
 * 2. `confirmGoalContract`：**用户确认**后才生成 `GoalContract` 并落盘。
 *
 * 本模块只含纯函数与提案存储；不读任务链、不派发、不联网。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";
import type {
  GoalCompletionPredicateKind,
  GoalContract,
  GoalResourceLimits,
} from "./goal-contract.js";

export const GOAL_PROPOSAL_SCHEMA_VERSION = 1;
export const DEFAULT_GOAL_PROPOSAL_LIFETIME_SECONDS = 30 * 60;

export interface GoalProposalRequirement {
  readonly requirementIdentifier: string;
  readonly description: string;
  readonly weight: number;
  readonly completionPredicateKind: GoalCompletionPredicateKind;
}

export interface GoalContractProposalDraft {
  readonly objectiveText: string;
  readonly requirements: readonly GoalProposalRequirement[];
  readonly scope: {
    readonly projectIdentifiers: readonly string[];
    readonly allowedToolNames: readonly string[] | null;
  };
  readonly nonViolableInvariants: readonly string[];
  readonly resourceLimits: GoalResourceLimits;
  readonly deadlineIso: string | null;
  readonly pauseConditions: readonly string[];
}

export interface GoalContractProposal {
  readonly schemaVersion: typeof GOAL_PROPOSAL_SCHEMA_VERSION;
  readonly proposalIdentifier: string;
  /** 原始要求引用（由 harness 注入，模型不能改）。 */
  readonly sourceRequestReference: string;
  readonly draft: GoalContractProposalDraft;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
  readonly confirmedAtIso: string | null;
  readonly confirmedGoalIdentifier: string | null;
}

export function validateGoalProposal(input: {
  readonly proposal: GoalContractProposal;
  readonly nowIso: string;
}): { readonly isValid: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (input.proposal.proposalIdentifier.trim() === "") {
    reasons.push("缺少 proposalIdentifier");
  }
  if (input.proposal.sourceRequestReference.trim() === "") {
    reasons.push("缺少原始要求引用（必须由 harness 注入，模型不可自填）");
  }
  if (input.proposal.draft.objectiveText.trim() === "") {
    reasons.push("目标描述不能为空");
  }
  if (input.proposal.draft.requirements.length === 0) {
    reasons.push("提案必须至少包含一条要求（不允许空目标）");
  }
  const seenIdentifiers = new Set<string>();
  for (const requirement of input.proposal.draft.requirements) {
    if (requirement.requirementIdentifier.trim() === "") {
      reasons.push("要求标识不能为空");
      continue;
    }
    if (seenIdentifiers.has(requirement.requirementIdentifier)) {
      reasons.push(`要求标识重复: ${requirement.requirementIdentifier}`);
    }
    seenIdentifiers.add(requirement.requirementIdentifier);
    if (!Number.isFinite(requirement.weight) || requirement.weight <= 0) {
      reasons.push(`要求 ${requirement.requirementIdentifier} 的权重必须为正数`);
    }
  }
  const expiresAtMilliseconds = Date.parse(input.proposal.expiresAtIso);
  const nowMilliseconds = Date.parse(input.nowIso);
  if (Number.isNaN(expiresAtMilliseconds) || Number.isNaN(nowMilliseconds)) {
    reasons.push("提案或当前时间不可解析");
  } else if (nowMilliseconds > expiresAtMilliseconds) {
    reasons.push("提案已过期，需重新提议并由用户确认");
  }
  return { isValid: reasons.length === 0, reasons };
}

/** 用户确认后，把提案转成**契约**（revision 固定为 1；任务节点映射留空，由 K2 写入）。 */
export function buildGoalContractFromProposal(input: {
  readonly proposal: GoalContractProposal;
  readonly goalIdentifier: string;
  readonly ownerIdentifier: string;
}): GoalContract {
  if (input.goalIdentifier.trim() === "") {
    throw new DomainError("invalid-task-chain", "确认时必须给出 goalIdentifier。");
  }
  if (input.ownerIdentifier.trim() === "") {
    throw new DomainError(
      "task-sequence-permission-denied",
      "确认时必须绑定认证用户作为目标所有者。",
    );
  }
  return {
    schemaVersion: 1,
    goalIdentifier: input.goalIdentifier,
    revision: 1,
    ownerIdentifier: input.ownerIdentifier,
    sourceRequestReference: input.proposal.sourceRequestReference,
    objectiveText: input.proposal.draft.objectiveText,
    scope: {
      projectIdentifiers: [...input.proposal.draft.scope.projectIdentifiers],
      allowedToolNames:
        input.proposal.draft.scope.allowedToolNames === null
          ? null
          : [...input.proposal.draft.scope.allowedToolNames],
    },
    nonViolableInvariants: [...input.proposal.draft.nonViolableInvariants],
    requirements: input.proposal.draft.requirements.map((requirement) => ({
      requirementIdentifier: requirement.requirementIdentifier,
      description: requirement.description,
      weight: requirement.weight,
      completionPredicateKind: requirement.completionPredicateKind,
      /** K2：映射在执行中写入，不在契约里写死。 */
      taskNodeIdentifiers: [],
    })),
    resourceLimits: input.proposal.draft.resourceLimits,
    deadlineIso: input.proposal.draft.deadlineIso,
    pauseConditions: [...input.proposal.draft.pauseConditions],
    supersedesRevision: null,
  };
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 提案存储：`<state>/goal-mode/proposals/<proposal>.json`（原子写 + 备份）。 */
export class GoalContractProposalStore {
  private readonly directoryPath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "goal-mode", "proposals");
  }

  private filePath(proposalIdentifier: string): string {
    return path.join(
      this.directoryPath,
      `${sanitizePathSegment(proposalIdentifier)}.json`,
    );
  }

  async read(proposalIdentifier: string): Promise<GoalContractProposal | null> {
    const filePath = this.filePath(proposalIdentifier);
    const readResult = await readJsonWithBackupRecovery(filePath, `${filePath}.bak`);
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as Partial<GoalContractProposal> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      content.schemaVersion !== GOAL_PROPOSAL_SCHEMA_VERSION ||
      typeof content.proposalIdentifier !== "string" ||
      content.draft === undefined ||
      content.draft === null
    ) {
      return null;
    }
    return content as GoalContractProposal;
  }

  async save(proposal: GoalContractProposal): Promise<void> {
    await this.writeLock.runExclusive(async () => {
      await writeAtomicJson(this.filePath(proposal.proposalIdentifier), proposal);
    });
  }

  /**
   * 标记已确认（**只能确认一次**）。
   *
   * 已确认且目标一致 ⇒ 幂等；已确认但目标不同 ⇒ `journal-corrupted`（禁止一份提案生出两个目标）。
   */
  async markConfirmed(input: {
    readonly proposalIdentifier: string;
    readonly confirmedGoalIdentifier: string;
    readonly confirmedAtIso: string;
  }): Promise<GoalContractProposal> {
    return await this.writeLock.runExclusive(async () => {
      const existing = await this.read(input.proposalIdentifier);
      if (existing === null) {
        throw new DomainError(
          "mission-not-found",
          `提案不存在: ${input.proposalIdentifier}`,
        );
      }
      if (existing.confirmedAtIso !== null) {
        if (existing.confirmedGoalIdentifier === input.confirmedGoalIdentifier) {
          return existing;
        }
        throw new DomainError(
          "journal-corrupted",
          `提案 ${input.proposalIdentifier} 已确认给目标 ${String(existing.confirmedGoalIdentifier)}，拒绝再生成第二个目标。`,
        );
      }
      const next: GoalContractProposal = {
        ...existing,
        confirmedAtIso: input.confirmedAtIso,
        confirmedGoalIdentifier: input.confirmedGoalIdentifier,
      };
      await writeAtomicJson(this.filePath(next.proposalIdentifier), next);
      return next;
    });
  }
}
