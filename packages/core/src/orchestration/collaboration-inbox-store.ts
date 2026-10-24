/**
 * COMM-01-02（2026-10-24）：**收件箱持久化**。
 *
 * 纪律：
 * 1. 每个收件人一个文件：`<base>/collaboration/inbox/<sanitized-recipient>.json`；
 * 2. 写入用原子替换 + `beforeCommit` 复核 revision（乐观并发）⇒ 陈旧写入被拒；
 * 3. **损坏文件不得被静默覆盖**：读取返回 `invalid` 并带原因，保存也会拒绝；
 * 4. 未保存过 ⇒ `absent`（不伪造空收件箱）；
 * 5. 备份文件 `<file>.bak` 由原子写/恢复工具维护。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";
import {
  COLLABORATION_INBOX_STATES,
  CollaborationInbox,
  type CollaborationInboxMessage,
  type CollaborationInboxState,
} from "./collaboration-inbox.js";

export const COLLABORATION_INBOX_SCHEMA_VERSION = 1;

export interface CollaborationInboxSnapshot {
  readonly schemaVersion: typeof COLLABORATION_INBOX_SCHEMA_VERSION;
  readonly recipientAgentInstanceId: string;
  readonly revision: number;
  readonly updatedAtIso: string;
  readonly messages: ReadonlyArray<CollaborationInboxMessage>;
}

export type CollaborationInboxReadOutcome =
  | { readonly kind: "absent" }
  | {
      readonly kind: "valid";
      readonly snapshot: CollaborationInboxSnapshot;
      readonly recoveredFromBackup: boolean;
    }
  | { readonly kind: "invalid"; readonly reason: string };

export class CollaborationInboxRevisionConflictError extends Error {
  readonly code = "collaboration-inbox-revision-conflict";
}

export interface CollaborationInboxStoreOptions {
  readonly baseDirectory: string;
}

function sanitizeRecipient(recipientAgentInstanceId: string): string {
  const sanitized = recipientAgentInstanceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized === "" ? "_empty" : sanitized;
}

export class CollaborationInboxStore {
  private readonly baseDirectory: string;

  constructor(options: CollaborationInboxStoreOptions) {
    this.baseDirectory = options.baseDirectory;
  }

  /** 收件人对应的文件路径（测试与排查用）。 */
  pathFor(recipientAgentInstanceId: string): string {
    return path.join(
      this.baseDirectory,
      "collaboration",
      "inbox",
      `${sanitizeRecipient(recipientAgentInstanceId)}.json`,
    );
  }

  private backupPathFor(recipientAgentInstanceId: string): string {
    return `${this.pathFor(recipientAgentInstanceId)}.bak`;
  }

  /** 读取收件箱快照：absent / valid / invalid（损坏不掩盖）。 */
  async read(recipientAgentInstanceId: string): Promise<CollaborationInboxReadOutcome> {
    let recovery;
    try {
      recovery = await readJsonWithBackupRecovery(
        this.pathFor(recipientAgentInstanceId),
        this.backupPathFor(recipientAgentInstanceId),
      );
    } catch (error) {
      return {
        kind: "invalid",
        reason: "读取收件箱失败：" + (error instanceof Error ? error.message : String(error)),
      };
    }
    if (recovery === null) return { kind: "absent" };

    const parsed = parseSnapshot(recovery.content, recipientAgentInstanceId);
    if (parsed.kind === "invalid") return parsed;
    return {
      kind: "valid",
      snapshot: parsed.snapshot,
      recoveredFromBackup: recovery.recoveredFromBackup,
    };
  }

  /**
   * 保存快照（乐观并发）。
   *
   * `expectedRevision === 0` 只适用于"从未保存过"的收件人；
   * 已存在时必须与当前 revision 一致，否则抛冲突。
   */
  /**
   * 列出已有收件箱文件（只读；供状态查询枚举）。
   *
   * 文件名做过安全化，收件人标识以文件内容为准；内容不可读时回退到文件名（由调用方按 invalid 计数）。
   */
  async listInboxes(): Promise<{
    readonly inboxes: ReadonlyArray<{ readonly recipientAgentInstanceId: string }>;
  }> {
    const directoryPath = path.join(this.baseDirectory, "collaboration", "inbox");
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { inboxes: [] };
      throw error;
    }
    const inboxes: Array<{ recipientAgentInstanceId: string }> = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = path.join(directoryPath, fileName);
      try {
        const rawContent = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        const recipientAgentInstanceId = parsed["recipientAgentInstanceId"];
        if (typeof recipientAgentInstanceId === "string" && recipientAgentInstanceId !== "") {
          inboxes.push({ recipientAgentInstanceId });
          continue;
        }
      } catch {
        // 落到下方回退分支（损坏文件仍会被枚举，方便上层如实计数）。
      }
      inboxes.push({ recipientAgentInstanceId: fileName.slice(0, -".json".length) });
    }
    return { inboxes };
  }
  async save(
    recipientAgentInstanceId: string,
    input: {
      readonly messages: ReadonlyArray<CollaborationInboxMessage>;
      readonly expectedRevision: number;
      readonly updatedAtIso: string;
    },
  ): Promise<{ readonly revision: number }> {
    const current = await this.read(recipientAgentInstanceId);
    if (current.kind === "invalid") {
      throw new Error("收件箱文件损坏，拒绝覆盖：" + current.reason);
    }
    const currentRevision = current.kind === "valid" ? current.snapshot.revision : 0;
    if (input.expectedRevision !== currentRevision) {
      throw new CollaborationInboxRevisionConflictError(
        "收件箱 revision 冲突：期望 " +
          String(input.expectedRevision) +
          "，当前 " +
          String(currentRevision) +
          "（可能已被其他写入者更新）。",
      );
    }

    const nextRevision = currentRevision + 1;
    const filePath = this.pathFor(recipientAgentInstanceId);
    await writeAtomicJson(
      filePath,
      {
        schemaVersion: COLLABORATION_INBOX_SCHEMA_VERSION,
        recipientAgentInstanceId,
        revision: nextRevision,
        updatedAtIso: input.updatedAtIso,
        messages: input.messages,
      },
      {
        beforeCommit: async () => {
          const latest = await this.read(recipientAgentInstanceId);
          if (latest.kind === "invalid") {
            throw new Error("提交前复核发现文件损坏，放弃写入。");
          }
          const latestRevision = latest.kind === "valid" ? latest.snapshot.revision : 0;
          if (latestRevision !== currentRevision) {
            throw new CollaborationInboxRevisionConflictError(
              "提交前复核发现 revision 已变化（" +
                String(currentRevision) +
                " → " +
                String(latestRevision) +
                "），放弃本次写入。",
            );
          }
        },
      },
    );
    return { revision: nextRevision };
  }
}

function parseSnapshot(
  content: unknown,
  recipientAgentInstanceId: string,
): { readonly kind: "valid"; readonly snapshot: CollaborationInboxSnapshot } | { readonly kind: "invalid"; readonly reason: string } {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    return { kind: "invalid", reason: "快照不是对象。" };
  }
  const record = content as Record<string, unknown>;
  if (record["schemaVersion"] !== COLLABORATION_INBOX_SCHEMA_VERSION) {
    return {
      kind: "invalid",
      reason:
        "schemaVersion 不受支持（期望 " +
        String(COLLABORATION_INBOX_SCHEMA_VERSION) +
        "，收到 " +
        String(record["schemaVersion"]) +
        "）。",
    };
  }
  if (record["recipientAgentInstanceId"] !== recipientAgentInstanceId) {
    return { kind: "invalid", reason: "收件人标识与文件名不一致。" };
  }
  const revision = record["revision"];
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    return { kind: "invalid", reason: "revision 必须是正整数。" };
  }
  const messages = record["messages"];
  if (!Array.isArray(messages)) {
    return { kind: "invalid", reason: "messages 必须是数组。" };
  }
  for (const message of messages) {
    if (message === null || typeof message !== "object") {
      return { kind: "invalid", reason: "messages 中存在非对象条目。" };
    }
    const item = message as Record<string, unknown>;
    if (typeof item["messageIdentifier"] !== "string" || item["messageIdentifier"] === "") {
      return { kind: "invalid", reason: "消息缺少 messageIdentifier。" };
    }
    if (!(COLLABORATION_INBOX_STATES as ReadonlyArray<string>).includes(item["state"] as string)) {
      return {
        kind: "invalid",
        reason:
          "消息 `" +
          String(item["messageIdentifier"]) +
          "` 的状态不在允许集合内：" +
          String(item["state"]),
      };
    }
  }
  // 旧快照兼容：缺少 originalSource / isRelayedRequest 时按 sender / false 归一，
  // 不因此丢弃历史消息（也不把缺失伪装成“已追溯”）。
  const normalizedMessages = (messages as ReadonlyArray<Record<string, unknown>>).map((message) => ({
    ...message,
    originalSourceAgentInstanceId:
      typeof message["originalSourceAgentInstanceId"] === "string" &&
      message["originalSourceAgentInstanceId"] !== ""
        ? message["originalSourceAgentInstanceId"]
        : (message["senderAgentInstanceId"] as string),
    isRelayedRequest: typeof message["isRelayedRequest"] === "boolean" ? message["isRelayedRequest"] : false,
  })) as unknown as ReadonlyArray<CollaborationInboxMessage>;
  return {
    kind: "valid",
    snapshot: {
      schemaVersion: COLLABORATION_INBOX_SCHEMA_VERSION,
      recipientAgentInstanceId,
      revision: revision as number,
      updatedAtIso: typeof record["updatedAtIso"] === "string" ? record["updatedAtIso"] : "",
      messages: normalizedMessages,
    },
  };
}

export type { CollaborationInboxState };
export { CollaborationInbox };





