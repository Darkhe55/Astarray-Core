/**
 * COORD-05 05-04（2026-11-22）：**呈交与答复**。
 *
 * 规则（卡内）：
 * - 先**持久化待呈交记录**，再发送（崩溃恢复时不会重复产生"逻辑问题"）；
 * - 控制面读取秘书**实际激活状态**，选择唯一通道（秘书 / 直接用户）；
 * - 区分 待呈交 / 已呈交 / 用户已答复；
 * - 已呈交（有回执）不得二次发送；待呈交（无回执）可在重启/故障后按同一待决 ID 恢复；
 * - 只有与原项目、原请求匹配的答复才写回。
 *
 * 本模块不做 UI：秘书/用户通道由端口注入（真实宿主或测试桩）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";
import { withFileLock } from "../infra/file-lock.js";

export type DecisionSubmissionState = "pending-record" | "submitted" | "answered";
export type DecisionChannel = "secretary" | "direct-user";

export interface DecisionSubmissionRecord {
  readonly submissionIdentifier: string;
  readonly projectIdentifier: string;
  readonly decisionId: string;
  readonly summary: string;
  readonly recommendedReason: string | null;
  readonly affectedStepIdentifiers: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<{
    readonly candidateIdentifier: string;
    readonly label: string;
    readonly value: string;
  }>;
  readonly state: DecisionSubmissionState;
  readonly channel: DecisionChannel | null;
  readonly receiptIdentifier: string | null;
  readonly createdAtIso: string;
  readonly submittedAtIso: string | null;
  readonly answeredAtIso: string | null;
  readonly answer: string | null;
}

interface DecisionSubmissionFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly submissions: ReadonlyArray<DecisionSubmissionRecord>;
}

export type DecisionSubmissionReadState =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly document: DecisionSubmissionFile }
  | { readonly kind: "corrupted"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

export class DecisionSubmissionStore {
  private readonly filePath: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "escalations", "submissions.json");
  }

  private get lockFilePath(): string {
    return path.join(path.dirname(this.filePath), "submissions.lock");
  }

  async readState(): Promise<DecisionSubmissionReadState> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        return { kind: "missing" };
      }
      return {
        kind: "unreadable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const parsed = JSON.parse(rawContent) as DecisionSubmissionFile;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.submissions)
      ) {
        return { kind: "corrupted", reason: "schemaVersion/submissions 结构非法" };
      }
      return { kind: "valid", document: parsed };
    } catch (error) {
      return {
        kind: "corrupted",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async requireReadable(): Promise<DecisionSubmissionFile> {
    const state = await this.readState();
    if (state.kind === "corrupted") {
      throw new Error("呈交记录损坏，拒绝覆盖：" + state.reason);
    }
    if (state.kind === "unreadable") {
      throw new Error("呈交记录暂时不可读，拒绝写入：" + state.reason);
    }
    return state.kind === "valid"
      ? state.document
      : { schemaVersion: 1, revision: 0, submissions: [] };
  }

  async list(): Promise<ReadonlyArray<DecisionSubmissionRecord>> {
    const state = await this.readState();
    return state.kind === "valid" ? state.document.submissions : [];
  }

  /** 先落盘待呈交记录（幂等：同一 submissionIdentifier 不重复登记）。 */
  async upsertPending(record: DecisionSubmissionRecord): Promise<DecisionSubmissionRecord> {
    return withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = await this.requireReadable();
      const existing = current.submissions.find(
        (candidate) => candidate.submissionIdentifier === record.submissionIdentifier,
      );
      if (existing !== undefined) {
        return existing;
      }
      const pending: DecisionSubmissionRecord = {
        ...record,
        state: "pending-record",
        channel: null,
        receiptIdentifier: null,
        submittedAtIso: null,
        answeredAtIso: null,
        answer: null,
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: current.revision + 1,
        submissions: [...current.submissions, pending],
      } satisfies DecisionSubmissionFile);
      return pending;
    });
  }

  /** 标记已呈交（只从 pending-record 迁移；重复回执不重复写）。 */
  async markSubmitted(input: {
    submissionIdentifier: string;
    channel: DecisionChannel;
    receiptIdentifier: string;
    submittedAtIso: string;
  }): Promise<DecisionSubmissionRecord> {
    return withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = await this.requireReadable();
      const existing = current.submissions.find(
        (candidate) => candidate.submissionIdentifier === input.submissionIdentifier,
      );
      if (existing === undefined) {
        throw new Error("待呈交记录不存在：" + input.submissionIdentifier);
      }
      if (existing.state === "submitted" || existing.state === "answered") {
        return existing;
      }
      if (existing.state !== "pending-record") {
        throw new Error("非法迁移：仅 pending-record 可标记已呈交。");
      }
      const updated: DecisionSubmissionRecord = {
        ...existing,
        state: "submitted",
        channel: input.channel,
        receiptIdentifier: input.receiptIdentifier,
        submittedAtIso: input.submittedAtIso,
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: current.revision + 1,
        submissions: current.submissions.map((candidate) =>
          candidate.submissionIdentifier === input.submissionIdentifier ? updated : candidate,
        ),
      } satisfies DecisionSubmissionFile);
      return updated;
    });
  }

  /**
   * 用户答复写回：必须与原项目、原请求匹配；已答复幂等（同答案原样返回）。
   */
  async markAnswered(input: {
    submissionIdentifier: string;
    projectIdentifier: string;
    answer: string;
    answeredAtIso: string;
  }): Promise<
    | { readonly kind: "answered"; readonly record: DecisionSubmissionRecord }
    | { readonly kind: "refused"; readonly code: "not-found" | "project-mismatch" | "not-submitted"; readonly reason: string }
  > {
    const answer = input.answer.trim();
    if (answer === "") {
      return { kind: "refused", code: "not-found", reason: "答复不能为空。" };
    }
    return withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = await this.requireReadable();
      const existing = current.submissions.find(
        (candidate) => candidate.submissionIdentifier === input.submissionIdentifier,
      );
      if (existing === undefined) {
        return { kind: "refused" as const, code: "not-found" as const, reason: "呈交记录不存在。" };
      }
      if (existing.projectIdentifier !== input.projectIdentifier) {
        return {
          kind: "refused" as const,
          code: "project-mismatch" as const,
          reason: "答复的项目与呈交记录不一致。",
        };
      }
      if (existing.state === "answered") {
        return { kind: "answered" as const, record: existing };
      }
      if (existing.state !== "submitted") {
        return {
          kind: "refused" as const,
          code: "not-submitted" as const,
          reason: "记录尚未呈交，不能写回答复。",
        };
      }
      const updated: DecisionSubmissionRecord = {
        ...existing,
        state: "answered",
        answer,
        answeredAtIso: input.answeredAtIso,
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: current.revision + 1,
        submissions: current.submissions.map((candidate) =>
          candidate.submissionIdentifier === input.submissionIdentifier ? updated : candidate,
        ),
      } satisfies DecisionSubmissionFile);
      return { kind: "answered" as const, record: updated };
    });
  }
}

export interface DecisionChannelPort {
  submit(input: {
    readonly submissionIdentifier: string;
    readonly projectIdentifier: string;
    readonly decisionId: string;
    readonly summary: string;
    readonly recommendedReason: string | null;
    readonly affectedStepIdentifiers: ReadonlyArray<string>;
    readonly candidates: DecisionSubmissionRecord["candidates"];
  }): Promise<{ readonly receiptIdentifier: string }>;
}

export interface DecisionSubmissionServiceDeps {
  readonly store: DecisionSubmissionStore;
  /** 秘书实际激活状态（由控制面读取，不缓存“上次状态”）。 */
  readonly isSecretaryActivated: () => Promise<boolean>;
  readonly secretaryChannel: DecisionChannelPort;
  readonly userChannel: DecisionChannelPort;
}

export type SubmitDecisionOutcome =
  | {
      readonly kind: "submitted";
      readonly channel: DecisionChannel;
      readonly receiptIdentifier: string;
      readonly record: DecisionSubmissionRecord;
    }
  | { readonly kind: "duplicate"; readonly record: DecisionSubmissionRecord }
  | { readonly kind: "refused"; readonly code: "channel-unavailable" | "corrupted-store"; readonly reason: string };

/**
 * 呈交一次决策摘要：**先持久化，再发送**。
 *
 * - 已有 submitted/answered ⇒ duplicate（不产生第二个逻辑问题）；
 * - 发送失败 ⇒ 记录保持 pending-record，返回 channel-unavailable；重启后可恢复；
 * - 秘书启停只在**没有回执**时影响通道选择。
 */
export async function submitDecision(
  deps: DecisionSubmissionServiceDeps,
  input: {
    readonly submissionIdentifier: string;
    readonly projectIdentifier: string;
    readonly decisionId: string;
    readonly summary: string;
    readonly recommendedReason: string | null;
    readonly affectedStepIdentifiers: ReadonlyArray<string>;
    readonly candidates: DecisionSubmissionRecord["candidates"];
    readonly nowIso: string;
  },
): Promise<SubmitDecisionOutcome> {
  let record: DecisionSubmissionRecord;
  try {
    record = await deps.store.upsertPending({
      submissionIdentifier: input.submissionIdentifier,
      projectIdentifier: input.projectIdentifier,
      decisionId: input.decisionId,
      summary: input.summary,
      recommendedReason: input.recommendedReason,
      affectedStepIdentifiers: [...input.affectedStepIdentifiers],
      candidates: [...input.candidates],
      state: "pending-record",
      channel: null,
      receiptIdentifier: null,
      createdAtIso: input.nowIso,
      submittedAtIso: null,
      answeredAtIso: null,
      answer: null,
    });
  } catch (error) {
    return {
      kind: "refused",
      code: "corrupted-store",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (record.state === "submitted" || record.state === "answered") {
    return { kind: "duplicate", record };
  }

  const useSecretary = await deps.isSecretaryActivated();
  const channel: DecisionChannel = useSecretary ? "secretary" : "direct-user";
  const port = useSecretary ? deps.secretaryChannel : deps.userChannel;
  let receiptIdentifier: string;
  try {
    const receipt = await port.submit({
      submissionIdentifier: record.submissionIdentifier,
      projectIdentifier: record.projectIdentifier,
      decisionId: record.decisionId,
      summary: record.summary,
      recommendedReason: record.recommendedReason,
      affectedStepIdentifiers: record.affectedStepIdentifiers,
      candidates: record.candidates,
    });
    receiptIdentifier = receipt.receiptIdentifier;
  } catch (error) {
    /** 记录保持 pending-record：重启/下次调用按同一待决 ID 恢复。 */
    return {
      kind: "refused",
      code: "channel-unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const submitted = await deps.store.markSubmitted({
    submissionIdentifier: record.submissionIdentifier,
    channel,
    receiptIdentifier,
    submittedAtIso: input.nowIso,
  });
  return { kind: "submitted", channel, receiptIdentifier, record: submitted };
}
