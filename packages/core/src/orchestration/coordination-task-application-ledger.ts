/**
 * COORD / P1-1（2026-11-17）：**协调消息的业务应用台账**。
 *
 * 要解决的真实崩溃窗口：
 *
 * ```text
 * 消费器把邮件标成 applied（协调处理进度）
 *   → 外层回调才去更新权威任务状态
 *   → 两步之间崩溃 ⇒ 邮件"已应用"，任务状态却没变
 *   → 且幂等重放不再触发外层更新 ⇒ 永久漏处理
 * ```
 *
 * 本台账把"准备更新权威状态"这件事**先持久化**（意图），再执行更新，最后记结论：
 *
 * 1. `recordIntent`：写 `pending`（含 mission/task 定位信息）——**先于**任何业务写入；
 * 2. 业务更新（任务链 / 运行中调度器）——本身必须是幂等的；
 * 3. `markCompleted` / `markFailed`：写结论与原因。
 *
 * 崩溃在 1 与 2 之间 ⇒ 重启后仍是 `pending`，补齐；
 * 崩溃在 2 与 3 之间 ⇒ 重启后重放业务更新，靠幂等保证不重复产生副作用。
 *
 * **权威状态仍然只有一处**（任务链 + 调度器）；台账只记"这件事做到哪一步"，不存业务结论。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export type CoordinationTaskApplicationStatus = "pending" | "completed" | "failed";

export interface CoordinationTaskApplicationEntry {
  readonly messageIdentifier: string;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string | null;
  readonly status: CoordinationTaskApplicationStatus;
  /** 失败或阻塞的原因（`completed` 时为 null）。 */
  readonly reason: string | null;
  /** 内容指纹（同键异内容必须拒绝，不能复用成另一件事）。 */
  readonly contentFingerprint?: string;
  /** 该消息对应的执行尝试（无法确定时缺省，不默认绑定当前执行）。 */
  readonly executionAttemptIdentifier?: string | null;
  readonly updatedAtIso: string;
}

interface CoordinationTaskApplicationDocument {
  readonly schemaVersion: 1;
  readonly documentRevision: number;
  readonly entries: readonly CoordinationTaskApplicationEntry[];
}

const SCHEMA_VERSION = 1;

export class CoordinationTaskApplicationLedger {
  private readonly filePath: string;
  private readonly nowIso: () => string;

  constructor(options: { readonly baseDirectory: string; readonly nowIso?: () => string }) {
    this.filePath = path.join(options.baseDirectory, "coordination", "task-application-ledger.json");
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  private async readDocument(): Promise<CoordinationTaskApplicationDocument> {
    const primaryPath = this.filePath;
    const readResult = await readJsonWithBackupRecovery(primaryPath, `${primaryPath}.bak`);
    if (readResult === null) {
      return { schemaVersion: SCHEMA_VERSION, documentRevision: 0, entries: [] };
    }
    const document = readResult.content as CoordinationTaskApplicationDocument;
    /** 版本不符 ⇒ 不猜测迁移，按空台账处理并让上层看到"没有记录"，不伪造已完成。 */
    if (document.schemaVersion !== SCHEMA_VERSION || !Array.isArray(document.entries)) {
      return { schemaVersion: SCHEMA_VERSION, documentRevision: 0, entries: [] };
    }
    return document;
  }

  private async writeDocument(
    previous: CoordinationTaskApplicationDocument,
    entries: readonly CoordinationTaskApplicationEntry[],
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await writeAtomicJson(this.filePath, {
      schemaVersion: SCHEMA_VERSION,
      documentRevision: previous.documentRevision + 1,
      entries,
    } satisfies CoordinationTaskApplicationDocument);
  }

  /** 读取全部条目（按消息标识）。 */
  async readAll(): Promise<ReadonlyMap<string, CoordinationTaskApplicationEntry>> {
    const document = await this.readDocument();
    return new Map(document.entries.map((entry) => [entry.messageIdentifier, entry]));
  }

  /** 需要补齐的条目：`pending`（还没做）或 `failed`（做过但失败）。 */
  async listRecoverable(): Promise<readonly CoordinationTaskApplicationEntry[]> {
    const document = await this.readDocument();
    return document.entries.filter((entry) => entry.status !== "completed");
  }

  /**
   * 记录**处理意图**（必须先于业务写入）。
   *
   * 幂等：已有 `completed` 的条目不会被降级回 `pending`（避免重放把已完成的事重开）。
   */
  async recordIntent(input: {
    readonly messageIdentifier: string;
    readonly missionIdentifier: string;
    readonly taskIdentifier: string | null;
    /** 内容指纹：同键异内容必须拒绝，不能"复用"成另一件事。 */
    readonly contentFingerprint?: string;
    readonly executionAttemptIdentifier?: string | null;
  }): Promise<{ readonly outcome: "recorded" | "reused" | "conflict"; readonly reason?: string }> {
    const document = await this.readDocument();
    const existing = document.entries.find(
      (entry) => entry.messageIdentifier === input.messageIdentifier,
    );
    if (existing !== undefined) {
      /** 同键同内容 ⇒ 复用；同键异内容 ⇒ 冲突（不覆盖、不冒充已完成）。 */
      if (
        input.contentFingerprint !== undefined &&
        existing.contentFingerprint !== undefined &&
        existing.contentFingerprint !== input.contentFingerprint
      ) {
        return {
          outcome: "conflict",
          reason: `同一消息标识出现不同内容（指纹 ${existing.contentFingerprint} vs ${input.contentFingerprint}）`,
        };
      }
      if (existing.status === "completed") {
        return { outcome: "reused" };
      }
    }
    const nextEntry: CoordinationTaskApplicationEntry = {
      messageIdentifier: input.messageIdentifier,
      missionIdentifier: input.missionIdentifier,
      taskIdentifier: input.taskIdentifier,
      status: "pending",
      reason: null,
      updatedAtIso: this.nowIso(),
      ...(input.contentFingerprint === undefined
        ? {}
        : { contentFingerprint: input.contentFingerprint }),
      ...(input.executionAttemptIdentifier === undefined
        ? {}
        : { executionAttemptIdentifier: input.executionAttemptIdentifier }),
    };
    const entries =
      existing === undefined
        ? [...document.entries, nextEntry]
        : document.entries.map((entry) =>
            entry.messageIdentifier === input.messageIdentifier ? nextEntry : entry,
          );
    await this.writeDocument(document, entries);
    return { outcome: existing === undefined ? "recorded" : "reused" };
  }

  /** 业务更新成功 ⇒ 记完成。 */
  async markCompleted(input: { readonly messageIdentifier: string }): Promise<void> {
    await this.updateEntry(input.messageIdentifier, (entry) => ({
      ...entry,
      status: "completed",
      reason: null,
      updatedAtIso: this.nowIso(),
    }));
  }

  /** 业务更新失败 ⇒ 记失败与原因（保留可恢复状态，**不吞异常**：调用方仍应抛出）。 */
  async markFailed(input: {
    readonly messageIdentifier: string;
    readonly reason: string;
  }): Promise<void> {
    await this.updateEntry(input.messageIdentifier, (entry) => ({
      ...entry,
      status: "failed",
      reason: input.reason,
      updatedAtIso: this.nowIso(),
    }));
  }

  private async updateEntry(
    messageIdentifier: string,
    updater: (entry: CoordinationTaskApplicationEntry) => CoordinationTaskApplicationEntry,
  ): Promise<void> {
    const document = await this.readDocument();
    if (!document.entries.some((entry) => entry.messageIdentifier === messageIdentifier)) {
      return;
    }
    await this.writeDocument(
      document,
      document.entries.map((entry) =>
        entry.messageIdentifier === messageIdentifier ? updater(entry) : entry,
      ),
    );
  }
}
