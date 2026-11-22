/**
 * 用户澄清请求（Agent 提问 / 候选建议）契约与持久化（2026-10-25）。
 *
 * 用途：Agent 在不确定时提出带**候选**的问题；用户可点候选或自由输入。
 * 默认无期限（与权限询问一致）；回答后记录答案，由上层决定如何恢复任务线。
 *
 * 本模块只提供契约与存储，**不伪造**任何候选：没有请求就没有候选。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { writeAtomicJson } from "../infra/atomic-json.js";
import { withFileLock } from "../infra/file-lock.js";

export interface ClarificationCandidate {
  readonly candidateIdentifier: string;
  readonly label: string;
  /** 选中后回传给 Agent 的值。 */
  readonly value: string;
  readonly isRecommended?: boolean;
}

export interface UserClarificationRequest {
  readonly clarificationIdentifier: string;
  readonly ownerAgentInstanceId: string;
  readonly taskIdentifier: string;
  readonly projectIdentifier: string;
  readonly questionText: string;
  readonly candidates: ReadonlyArray<ClarificationCandidate>;
  readonly allowFreeformInput: boolean;
  readonly createdAtIso: string;
  readonly status: "pending" | "answered";
  readonly answer: string | null;
  readonly answeredAtIso: string | null;
  /**
   * COORD-05 05-03（2026-11-22）：**上游原请求标识**。
   *
   * 同一项目 + 同一原请求的重试只登记一条待决事项（幂等）；旧记录没有该字段。
   */
  readonly sourceRequestIdentifier?: string | null;
  /** 影响面摘要（哪些步骤/产物受阻）。 */
  readonly impactSummary?: string | null;
  /** 推荐理由（由逐级上报层汇总，不得由执行者伪造"用户已决定"）。 */
  readonly recommendedReason?: string | null;
  /** 受阻步骤标识（只允许显式依赖该决定的步骤等待）。 */
  readonly blockedStepIdentifiers?: ReadonlyArray<string>;
}

/** 存储读取状态：区分首次无文件、损坏与暂时不可读（05-03 要求）。 */
export type UserClarificationReadState =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly document: ClarificationFile }
  | { readonly kind: "corrupted"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

interface ClarificationFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly requests: ReadonlyArray<UserClarificationRequest>;
}

export class UserClarificationStore {
  private readonly filePath: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "clarifications", "requests.json");
  }

  private get lockFilePath(): string {
    return path.join(path.dirname(this.filePath), "requests.lock");
  }

  /**
   * COORD-05 05-03：**严格读取**——区分首次无文件、损坏与暂时不可读。
   *
   * 旧实现把所有读取错误一律回退为空集合：文件损坏时下一次登记会覆盖它，
   * 用户已提出的问题被静默抹掉。这里保留诊断状态，破坏性写入必须显式拒绝。
   */
  async readState(): Promise<UserClarificationReadState> {
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
      const parsed = JSON.parse(rawContent) as ClarificationFile;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.requests)
      ) {
        return { kind: "corrupted", reason: "schemaVersion/requests 结构非法" };
      }
      return { kind: "valid", document: parsed };
    } catch (error) {
      return {
        kind: "corrupted",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 破坏性写入前必须能确定当前内容；损坏/不可读时拒绝覆盖。 */
  private async requireReadableDocument(): Promise<ClarificationFile> {
    const state = await this.readState();
    if (state.kind === "corrupted") {
      throw new Error("澄清存储损坏，拒绝覆盖（请先修复或恢复备份）：" + state.reason);
    }
    if (state.kind === "unreadable") {
      throw new Error("澄清存储暂时不可读，拒绝写入：" + state.reason);
    }
    return state.kind === "valid"
      ? state.document
      : { schemaVersion: 1, revision: 0, requests: [] };
  }

  async register(input: {
    ownerAgentInstanceId: string;
    taskIdentifier: string;
    projectIdentifier: string;
    questionText: string;
    candidates: ReadonlyArray<ClarificationCandidate>;
    allowFreeformInput?: boolean;
    createdAtIso: string;
    /** COORD-05 05-03：上游原请求标识；给出时按（项目, 原请求）幂等登记。 */
    sourceRequestIdentifier?: string | null;
    impactSummary?: string | null;
    recommendedReason?: string | null;
    blockedStepIdentifiers?: ReadonlyArray<string>;
  }): Promise<UserClarificationRequest> {
    const questionText = input.questionText.trim();
    if (questionText === "") throw new Error("澄清问题不能为空。");
    const ids = new Set<string>();
    for (const candidate of input.candidates) {
      if (candidate.candidateIdentifier.trim() === "" || candidate.value.trim() === "") {
        throw new Error("候选必须同时有 identifier 与 value。");
      }
      if (ids.has(candidate.candidateIdentifier)) throw new Error("候选标识重复。");
      ids.add(candidate.candidateIdentifier);
    }
    const sourceRequestIdentifier = input.sourceRequestIdentifier?.trim() ?? "";
    const blockedStepIdentifiers = [...(input.blockedStepIdentifiers ?? [])];
    for (const stepIdentifier of blockedStepIdentifiers) {
      if (stepIdentifier.trim() === "") {
        throw new Error("受阻步骤标识不能为空字符串。");
      }
    }

    return withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = await this.requireReadableDocument();
      /**
       * 05-03 幂等：同一项目 + 同一原请求的重试只生成一条待决事项；
       * 已有的（无论 pending/answered）原样返回，不重复登记、不覆盖答案。
       */
      if (sourceRequestIdentifier !== "") {
        const existing = current.requests.find(
          (request) =>
            request.projectIdentifier === input.projectIdentifier &&
            request.sourceRequestIdentifier === sourceRequestIdentifier,
        );
        if (existing !== undefined) {
          return existing;
        }
      }
      const request: UserClarificationRequest = {
        clarificationIdentifier:
          "clarify-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex"),
        ownerAgentInstanceId: input.ownerAgentInstanceId,
        taskIdentifier: input.taskIdentifier,
        projectIdentifier: input.projectIdentifier,
        questionText,
        candidates: input.candidates,
        allowFreeformInput: input.allowFreeformInput !== false,
        createdAtIso: input.createdAtIso,
        status: "pending",
        answer: null,
        answeredAtIso: null,
        ...(sourceRequestIdentifier === "" ? {} : { sourceRequestIdentifier }),
        ...(input.impactSummary === undefined ? {} : { impactSummary: input.impactSummary }),
        ...(input.recommendedReason === undefined
          ? {}
          : { recommendedReason: input.recommendedReason }),
        ...(blockedStepIdentifiers.length === 0 ? {} : { blockedStepIdentifiers }),
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: current.revision + 1,
        requests: [...current.requests, request],
      } satisfies ClarificationFile);
      return request;
    });
  }

  async listPending(projectIdentifier: string): Promise<ReadonlyArray<UserClarificationRequest>> {
    /** 兼容旧调用：读不出有效文档时返回空；诊断状态请用 `readState()`。 */
    const state = await this.readState();
    if (state.kind !== "valid") {
      return [];
    }
    return state.document.requests.filter(
      (request) => request.projectIdentifier === projectIdentifier && request.status === "pending",
    );
  }

  async answer(input: {
    clarificationIdentifier: string;
    answer: string;
    answeredAtIso: string;
  }): Promise<UserClarificationRequest> {
    const answer = input.answer.trim();
    if (answer === "") throw new Error("回答不能为空。");
    return withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = await this.requireReadableDocument();
      const existing = current.requests.find(
        (request) => request.clarificationIdentifier === input.clarificationIdentifier,
      );
      if (existing === undefined) throw new Error("澄清请求不存在。");
      if (existing.status !== "pending") throw new Error("该澄清请求已回答。");
      if (!existing.allowFreeformInput) {
        const matched = existing.candidates.some((candidate) => candidate.value === answer);
        if (!matched) throw new Error("该请求只接受候选项。");
      }
      const updated: UserClarificationRequest = {
        ...existing,
        status: "answered",
        answer,
        answeredAtIso: input.answeredAtIso,
      };
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: current.revision + 1,
        requests: current.requests.map((request) =>
          request.clarificationIdentifier === input.clarificationIdentifier ? updated : request,
        ),
      } satisfies ClarificationFile);
      return updated;
    });
  }
}
