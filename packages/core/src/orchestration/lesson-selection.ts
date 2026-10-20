/**
 * LESSON-01-02（2026-10-20）：**跨任务选择与三层范围**（精确选择、去重、版本失效、跨域不可读）。
 *
 * 卡内判据（L 行 LESSON-01-02）："现有工具扩展、三层范围及模型无关规范、审查推广、**精确选择**、
 * 附件/缓存/开关"；反例固定："**跨任务同配置命中但不带任务细节**；**不同模型/参数不误套**；
 * **原文不可越域读**；**去重与版本失效正确**"。
 *
 * 实现纪律：
 * 1. **同配置命中不带任务细节**：跨任务复用只保留可迁移的"事实/建议"，剔除源任务标识、证据引用、任务描述；
 * 2. **不同模型/参数不误套**：`role-model-config` 作用域要求模型快照（模型名+参数指纹）**完全一致**；
 *    模型无关规范（`model-independent-norm`）才允许跨模型；
 * 3. **原文不可越域读**：跨项目/跨个体只暴露摘要视图，原文读取一律拒绝并说明原因；
 * 4. **去重与版本失效**：内容指纹相同只保留最高 revision；revision 过期或 validity 失效的条目被排除。
 */
import { createHash } from "node:crypto";

import type { LessonModelSnapshot, LessonScopeKind } from "./lesson-record-contract.js";

/** 选择用的候选（调用方从存档读取；本模块不读盘）。 */
export interface LessonSelectionCandidate {
  readonly recordIdentifier: string;
  readonly revision: number;
  readonly scopeKind: LessonScopeKind;
  readonly ownerAgentInstanceId: string;
  readonly sourceTaskIdentifier: string;
  readonly sourceEvidenceReferences: ReadonlyArray<string>;
  readonly taskContextDescription: string;
  readonly observableFacts: ReadonlyArray<string>;
  readonly causeHypotheses: ReadonlyArray<string>;
  readonly nextActionAdvice: ReadonlyArray<string>;
  readonly validityStatus: "valid" | "stale" | "superseded";
  readonly publisherModelSnapshot: LessonModelSnapshot;
  readonly recipientModelSnapshot: LessonModelSnapshot;
  readonly isEnabled: boolean;
}

/** 选择请求。 */
export interface LessonSelectionRequest {
  readonly requestingAgentInstanceId: string;
  readonly taskIdentifier: string;
  /** 当前任务使用的模型快照（用于 role-model-config 作用域比对）。 */
  readonly currentModelSnapshot: LessonModelSnapshot;
  /** 只保留这些作用域（缺省 = 全部三层）。 */
  readonly allowedScopeKinds?: ReadonlyArray<LessonScopeKind>;
}

/** 单条选择结果。 */
export interface LessonSelectionEntry {
  readonly recordIdentifier: string;
  readonly scopeKind: LessonScopeKind;
  readonly revision: number;
  /** 是否跨任务复用（跨任务时**必须**剔除任务细节）。 */
  readonly isCrossTask: boolean;
  /** 是否已剔除任务细节（跨任务时恒为 true）。 */
  readonly isTaskDetailStripped: boolean;
  readonly observableFacts: ReadonlyArray<string>;
  readonly causeHypotheses: ReadonlyArray<string>;
  readonly nextActionAdvice: ReadonlyArray<string>;
  /** 被剔除的字段名（可见性核对用）。 */
  readonly strippedFieldNames: ReadonlyArray<string>;
}

/** 选择结果。 */
export interface LessonSelectionResult {
  readonly entries: ReadonlyArray<LessonSelectionEntry>;
  /** 因模型不匹配而排除的条目（说明原因，不是静默丢弃）。 */
  readonly excludedByModelMismatch: ReadonlyArray<string>;
  readonly excludedByScope: ReadonlyArray<string>;
  readonly excludedByValidity: ReadonlyArray<string>;
  readonly excludedByDisabledSwitch: ReadonlyArray<string>;
  /** task 作用域但**不是同一任务**：不得跨任务套用（精确选择）。 */
  readonly excludedByCrossTaskScope: ReadonlyArray<string>;
  readonly deduplicatedRecordIdentifiers: ReadonlyArray<string>;
}

/** 计算内容指纹（去重判据：只含可迁移内容）。 */
export function computeLessonContentFingerprint(candidate: LessonSelectionCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        candidate.observableFacts,
        candidate.causeHypotheses,
        candidate.nextActionAdvice,
        candidate.scopeKind,
      ]),
    )
    .digest("hex");
}

/** 模型快照是否一致（模型名 + 参数指纹）。 */
function isSameModelSnapshot(left: LessonModelSnapshot, right: LessonModelSnapshot): boolean {
  /**
   * 模型一致 = provider + model + 版本 + **实际生效配置**全部相同。
   * 任一不同都不允许套用（不同模型/参数不误套）。
   */
  return (
    left.providerIdentifier === right.providerIdentifier &&
    left.modelIdentifier === right.modelIdentifier &&
    left.modelVersionIdentifier === right.modelVersionIdentifier &&
    JSON.stringify(left.effectiveConfiguration) === JSON.stringify(right.effectiveConfiguration)
  );
}

/**
 * 精确选择：返回可用条目，并**逐条说明**被排除的原因。
 *
 * 顺序：开关 → 作用域 → 有效性 → 模型匹配 → 去重（同指纹保留最高 revision）。
 */
export function selectLessonsForTask(
  request: LessonSelectionRequest,
  candidates: ReadonlyArray<LessonSelectionCandidate>,
): LessonSelectionResult {
  const excludedByDisabledSwitch: string[] = [];
  const excludedByScope: string[] = [];
  const excludedByValidity: string[] = [];
  const excludedByModelMismatch: string[] = [];
  const excludedByCrossTaskScope: string[] = [];

  const allowedScopeKinds = request.allowedScopeKinds ?? [
    "task",
    "project",
    "role-model-config",
    "model-independent-norm",
  ];

  const applicable: LessonSelectionCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.isEnabled) {
      excludedByDisabledSwitch.push(candidate.recordIdentifier);
      continue;
    }
    if (!allowedScopeKinds.includes(candidate.scopeKind)) {
      excludedByScope.push(candidate.recordIdentifier);
      continue;
    }
    if (candidate.validityStatus !== "valid") {
      excludedByValidity.push(candidate.recordIdentifier);
      continue;
    }
    // task 作用域只对**同一任务**生效：跨任务不得套用（否则等于把旧任务细节带进新任务）
    if (candidate.scopeKind === "task" && candidate.sourceTaskIdentifier !== request.taskIdentifier) {
      excludedByCrossTaskScope.push(candidate.recordIdentifier);
      continue;
    }
    if (candidate.scopeKind === "role-model-config") {
      const isSameModel =
        isSameModelSnapshot(candidate.publisherModelSnapshot, request.currentModelSnapshot) &&
        isSameModelSnapshot(candidate.recipientModelSnapshot, request.currentModelSnapshot);
      if (!isSameModel) {
        excludedByModelMismatch.push(candidate.recordIdentifier);
        continue;
      }
    }
    applicable.push(candidate);
  }

  // 去重：同内容指纹保留最高 revision；被更替的记入去重列表
  const bestByFingerprint = new Map<string, LessonSelectionCandidate>();
  const deduplicatedRecordIdentifiers: string[] = [];
  for (const candidate of applicable) {
    const fingerprint = computeLessonContentFingerprint(candidate);
    const existing = bestByFingerprint.get(fingerprint);
    if (existing === undefined) {
      bestByFingerprint.set(fingerprint, candidate);
      continue;
    }
    if (candidate.revision > existing.revision) {
      deduplicatedRecordIdentifiers.push(existing.recordIdentifier);
      bestByFingerprint.set(fingerprint, candidate);
    } else {
      deduplicatedRecordIdentifiers.push(candidate.recordIdentifier);
    }
  }

  const entries = [...bestByFingerprint.values()].map((candidate) => {
    const isCrossTask =
      candidate.scopeKind !== "task" && candidate.sourceTaskIdentifier !== request.taskIdentifier;
    const strippedFieldNames = isCrossTask
      ? ["sourceTaskIdentifier", "sourceEvidenceReferences", "taskContextDescription"]
      : [];
    return {
      recordIdentifier: candidate.recordIdentifier,
      scopeKind: candidate.scopeKind,
      revision: candidate.revision,
      isCrossTask,
      isTaskDetailStripped: isCrossTask,
      observableFacts: candidate.observableFacts,
      causeHypotheses: candidate.causeHypotheses,
      nextActionAdvice: candidate.nextActionAdvice,
      strippedFieldNames,
    };
  });

  return {
    entries,
    excludedByModelMismatch,
    excludedByScope,
    excludedByValidity,
    excludedByDisabledSwitch,
    excludedByCrossTaskScope,
    deduplicatedRecordIdentifiers,
  };
}

/**
 * 原文读取的跨域判定：**跨项目/跨个体一律拒绝原文**。
 *
 * 注意：这里拒绝的是"原始文本"，不是"摘要视图"；调用方要展示时必须走摘要。
 */
export function evaluateLessonRawTextAccess(input: {
  readonly requestingAgentInstanceId: string;
  readonly ownerAgentInstanceId: string;
  readonly recordProjectIdentifier: string | null;
  readonly requestingProjectIdentifier: string | null;
}): { readonly kind: "allow" | "deny"; readonly reasonCode?: string; readonly reason: string } {
  if (input.requestingAgentInstanceId !== input.ownerAgentInstanceId) {
    return {
      kind: "deny",
      reasonCode: "cross-agent-raw-text-forbidden",
      reason: "跨个体不得读取教训原文（只能读摘要视图）。",
    };
  }
  if (
    input.recordProjectIdentifier !== null &&
    input.requestingProjectIdentifier !== null &&
    input.recordProjectIdentifier !== input.requestingProjectIdentifier
  ) {
    return {
      kind: "deny",
      reasonCode: "cross-project-raw-text-forbidden",
      reason: "跨项目不得读取教训原文（只能读摘要视图）。",
    };
  }
  return { kind: "allow", reason: "同一项目且同一个体：允许读取原文。" };
}



