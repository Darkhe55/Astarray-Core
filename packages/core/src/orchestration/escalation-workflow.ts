/**
 * COORD-05 控制面编排（2026-11-22）：把请求记录、路由、处置链与呈交/写回串成一条**可注入端口**的流程。
 *
 * - `open`：按真实管理树解析目标（agent / 用户），持久化请求记录；同 requestIdentifier 幂等。
 * - `handle`：当前处理人按"当前处理人 + 预期版本"追加结论；终态后拒绝再追加。
 * - `needs-user`：调用注入的用户呈交回调（一次；状态本身作为幂等键）。
 * - `resolved`：调用注入的写回回调（决定写回由 05-05 负责）。
 *
 * 本层不实现真实任务链/秘书通道；由装配方注入，便于反例与端到端测试。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";
import { withFileLock } from "../infra/file-lock.js";
import {
  appendEscalationDisposition,
  openEscalation,
  type EscalationDispositionEntry,
  type EscalationRecord,
  type OpenEscalationInput,
} from "./escalation-contract.js";

interface EscalationRequestFile {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly records: ReadonlyArray<EscalationRecord>;
}

export class EscalationRequestStore {
  private readonly filePath: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "escalations", "requests.json");
  }

  private get lockFilePath(): string {
    return path.join(path.dirname(this.filePath), "requests.lock");
  }

  private async readDocument(): Promise<EscalationRequestFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as EscalationRequestFile;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.records)
      ) {
        throw new Error("escalations/requests.json 结构非法");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, revision: 0, records: [] };
      }
      throw error;
    }
  }

  async list(): Promise<ReadonlyArray<EscalationRecord>> {
    return (await this.readDocument()).records;
  }

  async get(requestIdentifier: string): Promise<EscalationRecord | null> {
    const document = await this.readDocument();
    return (
      document.records.find((record) => record.requestIdentifier === requestIdentifier) ?? null
    );
  }

  async upsert(record: EscalationRecord): Promise<EscalationRecord> {
    let persisted = record;
    await withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = await this.readDocument();
      const existing = current.records.find(
        (candidate) => candidate.requestIdentifier === record.requestIdentifier,
      );
      if (existing !== undefined) {
        persisted = existing;
        return;
      }
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: current.revision + 1,
        records: [...current.records, record],
      } satisfies EscalationRequestFile);
    });
    return persisted;
  }

  /** 以预期版本更新（乐观并发）；不匹配 ⇒ 返回 null，不覆盖。 */
  async update(
    requestIdentifier: string,
    expectedVersion: number,
    next: EscalationRecord,
  ): Promise<EscalationRecord | null> {
    let updated: EscalationRecord | null = null;
    await withFileLock({ lockFilePath: this.lockFilePath }, async () => {
      const current = await this.readDocument();
      const existing = current.records.find(
        (candidate) => candidate.requestIdentifier === requestIdentifier,
      );
      if (existing === undefined || existing.version !== expectedVersion) {
        return;
      }
      updated = next;
      await writeAtomicJson(this.filePath, {
        schemaVersion: 1,
        revision: current.revision + 1,
        records: current.records.map((candidate) =>
          candidate.requestIdentifier === requestIdentifier ? next : candidate,
        ),
      } satisfies EscalationRequestFile);
    });
    return updated;
  }
}

export interface EscalationWorkflowDeps {
  readonly store: EscalationRequestStore;
  readonly resolveCreatorOf: (agentInstanceId: string) => Promise<string | null>;
  readonly isAgentKnown: (agentInstanceId: string) => Promise<boolean>;
  /** 到达用户通道时调用（呈交由 05-04 负责）。 */
  readonly onSubmitToUser?: (record: EscalationRecord) => Promise<{ readonly receiptIdentifier: string }>;
  /** 本层结案时调用（写回由 05-05 负责）。 */
  readonly onResolved?: (record: EscalationRecord) => Promise<void>;
}

export type EscalationOpenOutcome =
  | {
      readonly kind: "opened" | "existing";
      readonly record: EscalationRecord;
      readonly target:
        | { readonly kind: "agent"; readonly agentInstanceId: string }
        | { readonly kind: "user" };
    }
  | { readonly kind: "refused"; readonly code: string; readonly reason: string };

export type EscalationHandleOutcome =
  | { readonly kind: "updated"; readonly record: EscalationRecord }
  | { readonly kind: "submitted-to-user"; readonly record: EscalationRecord }
  | { readonly kind: "resolved"; readonly record: EscalationRecord }
  | { readonly kind: "refused"; readonly code: string; readonly reason: string };

export class EscalationWorkflow {
  constructor(private readonly deps: EscalationWorkflowDeps) {}

  async open(input: OpenEscalationInput): Promise<EscalationOpenOutcome> {
    const existing = await this.deps.store.get(input.requestIdentifier.trim());
    if (existing !== null) {
      return {
        kind: "existing",
        record: existing,
        target:
          existing.currentHandlerAgentInstanceId === null
            ? { kind: "user" }
            : { kind: "agent", agentInstanceId: existing.currentHandlerAgentInstanceId },
      };
    }
    const outcome = await openEscalation(input, {
      resolveCreatorOf: this.deps.resolveCreatorOf,
      isAgentKnown: this.deps.isAgentKnown,
    });
    if (outcome.kind === "refused") {
      return outcome;
    }
    const persisted = await this.deps.store.upsert(outcome.record);
    return { kind: "opened", record: persisted, target: outcome.target };
  }

  /**
   * 当前处理人追加结论。`needs-user` ⇒ 调用用户呈交（一次）；`resolved` ⇒ 调用写回（一次）。
   */
  async handle(input: {
    readonly requestIdentifier: string;
    readonly expectedVersion: number;
    readonly handlerAgentInstanceId: string;
    readonly disposition: EscalationDispositionEntry["disposition"];
    readonly reason: string;
    readonly referencedDocumentIdentifiers: ReadonlyArray<string>;
    readonly handledAtIso: string;
    readonly forwardToAgentInstanceId?: string | null;
  }): Promise<EscalationHandleOutcome> {
    const record = await this.deps.store.get(input.requestIdentifier);
    if (record === null) {
      return { kind: "refused", code: "not-found", reason: "请示请求不存在。" };
    }
    const outcome = appendEscalationDisposition({
      record,
      expectedVersion: input.expectedVersion,
      handlerAgentInstanceId: input.handlerAgentInstanceId,
      disposition: input.disposition,
      reason: input.reason,
      referencedDocumentIdentifiers: input.referencedDocumentIdentifiers,
      handledAtIso: input.handledAtIso,
      ...(input.forwardToAgentInstanceId === undefined
        ? {}
        : { forwardToAgentInstanceId: input.forwardToAgentInstanceId }),
    });
    if (outcome.kind === "refused") {
      return outcome;
    }
    const persisted = await this.deps.store.update(
      record.requestIdentifier,
      input.expectedVersion,
      outcome.record,
    );
    if (persisted === null) {
      return {
        kind: "refused",
        code: "stale-version",
        reason: "并发写入：请求版本已变化，结论未持久化。",
      };
    }
    if (persisted.state === "needs-user") {
      if (this.deps.onSubmitToUser !== undefined) {
        await this.deps.onSubmitToUser(persisted);
      }
      return { kind: "submitted-to-user", record: persisted };
    }
    if (persisted.state === "resolved-by-agent") {
      if (this.deps.onResolved !== undefined) {
        await this.deps.onResolved(persisted);
      }
      return { kind: "resolved", record: persisted };
    }
    return { kind: "updated", record: persisted };
  }

  async get(requestIdentifier: string): Promise<EscalationRecord | null> {
    return this.deps.store.get(requestIdentifier);
  }
}
