/**
 * EVENT-01（2026-10-24）：**事故日志持久化**（供安装包状态入口与崩溃重放）。
 *
 * 纪律：
 * - 单文件 `<state>/events/incidents.json`，原子写 + `beforeCommit` 复核 revision；
 * - 损坏文件**不覆盖**：读取返回 `invalid` 并给原因；
 * - 未写入过 ⇒ `absent`（空 ≠ 无事件）；
 * - 只存控制通道快照（状态/所有者/能力），不存模型输出与秘密。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import type { EventControlChannelSnapshot } from "./event-control-channel.js";

export const EVENT_INCIDENT_JOURNAL_SCHEMA_VERSION = 1;

export interface EventIncidentJournalRecord {
  readonly schemaVersion: typeof EVENT_INCIDENT_JOURNAL_SCHEMA_VERSION;
  readonly revision: number;
  readonly updatedAtIso: string;
  readonly snapshot: EventControlChannelSnapshot;
}

export type EventIncidentJournalReadOutcome =
  | { readonly kind: "absent" }
  | {
      readonly kind: "valid";
      readonly record: EventIncidentJournalRecord;
      readonly recoveredFromBackup: boolean;
    }
  | { readonly kind: "invalid"; readonly reason: string };

export class EventIncidentJournalRevisionConflictError extends Error {
  readonly code = "event-incident-journal-revision-conflict";
}

export class EventIncidentJournal {
  private readonly filePath: string;
  private readonly backupPath: string;

  constructor(options: { readonly stateDirectory: string }) {
    this.filePath = path.join(options.stateDirectory, "events", "incidents.json");
    this.backupPath = `${this.filePath}.bak`;
  }

  pathFor(): string {
    return this.filePath;
  }

  async read(): Promise<EventIncidentJournalReadOutcome> {
    let recovery;
    try {
      recovery = await readJsonWithBackupRecovery(this.filePath, this.backupPath);
    } catch (error) {
      return {
        kind: "invalid",
        reason: "读取事故日志失败：" + (error instanceof Error ? error.message : String(error)),
      };
    }
    if (recovery === null) return { kind: "absent" };

    const parsed = parseRecord(recovery.content);
    if (parsed.kind === "invalid") return parsed;
    return { kind: "valid", record: parsed.record, recoveredFromBackup: recovery.recoveredFromBackup };
  }

  async save(input: {
    readonly snapshot: EventControlChannelSnapshot;
    readonly expectedRevision: number;
    readonly updatedAtIso: string;
  }): Promise<{ readonly revision: number }> {
    const current = await this.read();
    if (current.kind === "invalid") {
      throw new Error("事故日志损坏，拒绝覆盖：" + current.reason);
    }
    const currentRevision = current.kind === "valid" ? current.record.revision : 0;
    if (input.expectedRevision !== currentRevision) {
      throw new EventIncidentJournalRevisionConflictError(
        "事故日志 revision 冲突：期望 " +
          String(input.expectedRevision) +
          "，当前 " +
          String(currentRevision) +
          "。",
      );
    }
    const nextRevision = currentRevision + 1;
    await writeAtomicJson(
      this.filePath,
      {
        schemaVersion: EVENT_INCIDENT_JOURNAL_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAtIso: input.updatedAtIso,
        snapshot: input.snapshot,
      },
      {
        beforeCommit: async () => {
          const latest = await this.read();
          if (latest.kind === "invalid") {
            throw new Error("提交前复核发现事故日志损坏，放弃写入。");
          }
          const latestRevision = latest.kind === "valid" ? latest.record.revision : 0;
          if (latestRevision !== currentRevision) {
            throw new EventIncidentJournalRevisionConflictError(
              "提交前复核发现 revision 已变化，放弃本次写入。",
            );
          }
        },
      },
    );
    return { revision: nextRevision };
  }

  /** 清空（仅用于事故解除后的归档；写入 revision+1 而不是删除文件）。 */
  async clear(expectedRevision: number, updatedAtIso: string): Promise<{ readonly revision: number }> {
    return this.save({
      snapshot: { schemaVersion: 1, incidents: [], toolCapabilities: [] },
      expectedRevision,
      updatedAtIso,
    });
  }

  /** 目录是否存在（测试/排查用，不创建）。 */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }
}

function parseRecord(
  content: unknown,
):
  | { readonly kind: "valid"; readonly record: EventIncidentJournalRecord }
  | { readonly kind: "invalid"; readonly reason: string } {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    return { kind: "invalid", reason: "事故日志不是对象。" };
  }
  const record = content as Record<string, unknown>;
  if (record["schemaVersion"] !== EVENT_INCIDENT_JOURNAL_SCHEMA_VERSION) {
    return {
      kind: "invalid",
      reason:
        "schemaVersion 不受支持（期望 " +
        String(EVENT_INCIDENT_JOURNAL_SCHEMA_VERSION) +
        "，收到 " +
        String(record["schemaVersion"]) +
        "）。",
    };
  }
  const revision = record["revision"];
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    return { kind: "invalid", reason: "revision 必须是正整数。" };
  }
  const snapshot = record["snapshot"];
  if (snapshot === null || typeof snapshot !== "object") {
    return { kind: "invalid", reason: "缺少 snapshot。" };
  }
  const snapshotRecord = snapshot as Record<string, unknown>;
  if (!Array.isArray(snapshotRecord["incidents"])) {
    return { kind: "invalid", reason: "snapshot.incidents 必须是数组。" };
  }
  for (const incident of snapshotRecord["incidents"]) {
    if (incident === null || typeof incident !== "object") {
      return { kind: "invalid", reason: "事故条目不是对象。" };
    }
    const item = incident as Record<string, unknown>;
    if (typeof item["incidentIdentifier"] !== "string" || item["incidentIdentifier"] === "") {
      return { kind: "invalid", reason: "事故条目缺少 incidentIdentifier。" };
    }
    if (typeof item["state"] !== "string") {
      return { kind: "invalid", reason: "事故条目缺少 state。" };
    }
  }
  return {
    kind: "valid",
    record: {
      schemaVersion: EVENT_INCIDENT_JOURNAL_SCHEMA_VERSION,
      revision: revision as number,
      updatedAtIso: typeof record["updatedAtIso"] === "string" ? record["updatedAtIso"] : "",
      snapshot: snapshot as EventControlChannelSnapshot,
    },
  };
}
