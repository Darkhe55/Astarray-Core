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
}

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

  private async readAll(): Promise<ClarificationFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as ClarificationFile;
      return parsed.schemaVersion === 1 && Array.isArray(parsed.requests)
        ? parsed
        : { schemaVersion: 1, revision: 0, requests: [] };
    } catch {
      return { schemaVersion: 1, revision: 0, requests: [] };
    }
  }

  async register(input: {
    ownerAgentInstanceId: string;
    taskIdentifier: string;
    projectIdentifier: string;
    questionText: string;
    candidates: ReadonlyArray<ClarificationCandidate>;
    allowFreeformInput?: boolean;
    createdAtIso: string;
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
    const current = await this.readAll();
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
    };
    await writeAtomicJson(this.filePath, {
      schemaVersion: 1,
      revision: current.revision + 1,
      requests: [...current.requests, request],
    } satisfies ClarificationFile);
    return request;
  }

  async listPending(projectIdentifier: string): Promise<ReadonlyArray<UserClarificationRequest>> {
    const current = await this.readAll();
    return current.requests.filter(
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
    const current = await this.readAll();
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
  }
}
