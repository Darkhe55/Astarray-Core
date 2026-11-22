/**
 * COORD-05 05-05（2026-11-22）：**决定写回与恢复**。
 *
 * 规则（卡内）：
 * - 本级决定与用户裁决都写回**权威文档**，记录来源、文档版本和影响范围；
 * - 只有**显式依赖该决定**的步骤等待，其他步骤继续调度；
 * - 写回与推进使用同一决定 ID；重复调用最多推进一次；
 * - 两个崩溃点（已回答未写回、已写回未推进）都可恢复；
 * - 迟到答案不得重启已取消任务；一次通知只发给受影响步骤；
 * - 文档版本冲突时**保留决定**并进入复核（不覆盖、不推进）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";
import { withFileLock } from "../infra/file-lock.js";

export type DecisionWritebackStatus =
  | "answered"
  | "written-back"
  | "advanced"
  | "cancelled"
  | "conflict";

export interface DecisionWritebackRecord {
  readonly decisionIdentifier: string;
  readonly escalationRequestIdentifier: string;
  readonly projectIdentifier: string;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly source: "agent" | "user";
  readonly summary: string;
  readonly affectedStepIdentifiers: ReadonlyArray<string>;
  readonly status: DecisionWritebackStatus;
  /** 写回时的权威文档 revision；未写回为 null。 */
  readonly documentRevision: number | null;
  /** 已通知（推进）的步骤：重试时跳过，保证"一次通知"。 */
  readonly advancedStepIdentifiers: ReadonlyArray<string>;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

interface DecisionWritebackFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly decisions: ReadonlyArray<DecisionWritebackRecord>;
}

export class DecisionWritebackStore {
  private readonly filePath: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "escalations", "decisions.json");
  }

  private get lockFilePath(): string {
    return path.join(path.dirname(this.filePath), "decisions.lock");
  }

  private async readDocument(): Promise<DecisionWritebackFile | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DecisionWritebackFile;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.decisions)
      ) {
        throw new Error("decisions 结构非法");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list(): Promise<ReadonlyArray<DecisionWritebackRecord>> {
    const document = await this.readDocument();
    return document?.decisions ?? [];
  }

  private async mutate(
    mutator: (current: DecisionWritebackFile) => DecisionWritebackFile,
  ): Promise<void> {
    await withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = (await this.readDocument()) ?? {
        schemaVersion: 1 as const,
        revision: 0,
        decisions: [],
      };
      await writeAtomicJson(this.filePath, mutator(current));
    });
  }

  /** 登记回答（幂等：同一决定 ID 已存在则原样返回）。 */
  async recordAnswer(record: DecisionWritebackRecord): Promise<DecisionWritebackRecord> {
    let persisted: DecisionWritebackRecord = record;
    await this.mutate((current) => {
      const existing = current.decisions.find(
        (candidate) => candidate.decisionIdentifier === record.decisionIdentifier,
      );
      if (existing !== undefined) {
        persisted = existing;
        return current;
      }
      persisted = { ...record, status: "answered" };
      return {
        schemaVersion: 1,
        revision: current.revision + 1,
        decisions: [...current.decisions, persisted],
      };
    });
    return persisted;
  }

  /** 单条更新的原子读-改-写；`mutator` 返回 null ⇒ 不写。 */
  async update(
    decisionIdentifier: string,
    mutator: (record: DecisionWritebackRecord) => DecisionWritebackRecord | null,
  ): Promise<DecisionWritebackRecord | null> {
    let updated: DecisionWritebackRecord | null = null;
    await this.mutate((current) => {
      const existing = current.decisions.find(
        (candidate) => candidate.decisionIdentifier === decisionIdentifier,
      );
      if (existing === undefined) {
        return current;
      }
      updated = mutator(existing);
      if (updated === null) {
        return current;
      }
      return {
        schemaVersion: 1,
        revision: current.revision + 1,
        decisions: current.decisions.map((candidate) =>
          candidate.decisionIdentifier === decisionIdentifier ? updated! : candidate,
        ),
      };
    });
    return updated;
  }
}

export interface DecisionWritebackPorts {
  /** 权威文档当前 revision（写回前读取，用于冲突检测）。 */
  readonly readDocumentRevision: () => Promise<number>;
  /** 把决定写回权威文档；expectedRevision 为 null 表示首次写回。 */
  readonly writeDecision: (input: {
    readonly decisionIdentifier: string;
    readonly escalationRequestIdentifier: string;
    readonly missionIdentifier: string;
    readonly taskIdentifier: string;
    readonly source: "agent" | "user";
    readonly summary: string;
    readonly affectedStepIdentifiers: ReadonlyArray<string>;
    readonly expectedRevision: number | null;
  }) => Promise<{ readonly documentRevision: number }>;
  /** 任务状态：cancelled 的 mission 不得被推进。 */
  readonly readMissionState: (missionIdentifier: string) => Promise<{
    readonly status: "running" | "cancelled" | "completed" | "unknown";
    readonly steps: ReadonlyArray<{
      readonly stepIdentifier: string;
      readonly status: "pending" | "running" | "done" | "failed" | "waiting-on-decision";
      readonly dependsOnDecisionIdentifiers: ReadonlyArray<string>;
    }>;
  }>;
  /** 通知/推进一个显式依赖该决定的步骤。 */
  readonly advanceStep: (stepIdentifier: string) => Promise<void>;
}

export type DecisionWritebackOutcome =
  | { readonly kind: "advanced"; readonly record: DecisionWritebackRecord; readonly advancedSteps: ReadonlyArray<string> }
  | { readonly kind: "duplicate"; readonly record: DecisionWritebackRecord }
  | { readonly kind: "cancelled"; readonly record: DecisionWritebackRecord }
  | { readonly kind: "deferred"; readonly record: DecisionWritebackRecord; readonly reason: string }
  | { readonly kind: "conflict"; readonly record: DecisionWritebackRecord; readonly reason: string };

/**
 * 幂等推进：写回（若未写）→ 只推进**显式依赖**该决定且未完成的步骤 → 记录已通知步骤。
 *
 * 崩溃点 A（已回答未写回）：记录为 answered，重试补写并推进；
 * 崩溃点 B（已写回未推进）：记录为 written-back，重试只推进，不重复写文档。
 */
export async function applyDecisionWriteback(
  deps: {
    readonly store: DecisionWritebackStore;
    readonly ports: DecisionWritebackPorts;
  },
  input: {
    readonly decisionIdentifier: string;
    readonly nowIso: string;
  },
): Promise<DecisionWritebackOutcome> {
  const decisions = await deps.store.list();
  const existing = decisions.find(
    (candidate) => candidate.decisionIdentifier === input.decisionIdentifier,
  );
  if (existing === undefined) {
    throw new Error("决定不存在，必须先登记回答：" + input.decisionIdentifier);
  }

  const mission = await deps.ports.readMissionState(existing.missionIdentifier);
  if (mission.status === "cancelled") {
    const cancelled =
      existing.status === "cancelled"
        ? existing
        : ((
            await deps.store.update(input.decisionIdentifier, (record) => ({
              ...record,
              status: "cancelled",
              updatedAtIso: input.nowIso,
            }))
          ) ?? existing);
    return { kind: "cancelled", record: cancelled };
  }

  /** 1. 写回（若尚未写回）。 */
  let record = existing;
  if (record.status === "answered") {
    let currentRevision: number;
    try {
      currentRevision = await deps.ports.readDocumentRevision();
    } catch (error) {
      /** 文档暂不可读（如任务链缺失）⇒ 保持 answered，返回 deferred 供重试。 */
      return {
        kind: "deferred",
        record,
        reason: "读取文档 revision 失败：" + (error instanceof Error ? error.message : String(error)),
      };
    }
    if (
      record.documentRevision !== null &&
      currentRevision < record.documentRevision
    ) {
      const conflict = await deps.store.update(input.decisionIdentifier, (candidate) => ({
        ...candidate,
        status: "conflict",
        updatedAtIso: input.nowIso,
      }));
      return {
        kind: "conflict",
        record: conflict ?? record,
        reason: "权威文档 revision 回退，保留决定并进入复核。",
      };
    }
    let written: { documentRevision: number };
    try {
      written = await deps.ports.writeDecision({
        decisionIdentifier: record.decisionIdentifier,
        escalationRequestIdentifier: record.escalationRequestIdentifier,
        missionIdentifier: record.missionIdentifier,
        taskIdentifier: record.taskIdentifier,
        source: record.source,
        summary: record.summary,
        affectedStepIdentifiers: record.affectedStepIdentifiers,
        expectedRevision: null,
      });
    } catch (error) {
      /** 崩溃点 A：保持 answered，后续重试补写。 */
      return {
        kind: "deferred",
        record,
        reason: "写回失败：" + (error instanceof Error ? error.message : String(error)),
      };
    }
    record =
      (await deps.store.update(input.decisionIdentifier, (candidate) => ({
        ...candidate,
        status: "written-back",
        documentRevision: written.documentRevision,
        updatedAtIso: input.nowIso,
      }))) ?? record;
  }

  if (record.status === "advanced") {
    return { kind: "duplicate", record };
  }
  if (record.status === "conflict") {
    return { kind: "conflict", record, reason: "决定处于复核状态，未推进。" };
  }

  /** 2. 只推进显式依赖该决定、仍等待中的步骤；已通知的跳过。 */
  const alreadyNotified = new Set(record.advancedStepIdentifiers);
  const targets = mission.steps.filter(
    (step) =>
      (step.dependsOnDecisionIdentifiers.includes(record.decisionIdentifier) ||
        record.affectedStepIdentifiers.includes(step.stepIdentifier)) &&
      step.status === "waiting-on-decision" &&
      !alreadyNotified.has(step.stepIdentifier),
  );
  const advancedSteps: string[] = [];
  for (const step of targets) {
    await deps.ports.advanceStep(step.stepIdentifier);
    advancedSteps.push(step.stepIdentifier);
    record =
      (await deps.store.update(input.decisionIdentifier, (candidate) => ({
        ...candidate,
        advancedStepIdentifiers: [
          ...candidate.advancedStepIdentifiers,
          step.stepIdentifier,
        ],
        updatedAtIso: input.nowIso,
      }))) ?? record;
  }
  const finalized =
    (await deps.store.update(input.decisionIdentifier, (candidate) => ({
      ...candidate,
      status: "advanced",
      updatedAtIso: input.nowIso,
    }))) ?? record;
  return { kind: "advanced", record: finalized, advancedSteps };
}
