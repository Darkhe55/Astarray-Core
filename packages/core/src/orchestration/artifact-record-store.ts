/**
 * GUI-03-06：权威任务成果记录（独立于项目文件树）。
 *
 * 只记录已登记的产物，不扫描目录；工具/任务成功路径应显式 register。
 */
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";

export type ArtifactVerificationStatus = "unverified" | "verified" | "failed";

export interface ArtifactRecord {
  readonly artifactIdentifier: string;
  readonly projectIdentifier: string;
  readonly missionIdentifier: string;
  readonly taskIdentifier: string;
  readonly sourceAgentInstanceId: string | null;
  readonly artifactType: string;
  readonly displayName: string;
  readonly location: string;
  readonly createdAtIso: string;
  readonly version: number;
  readonly contentDigest: string | null;
  readonly verificationStatus: ArtifactVerificationStatus;
}

export interface ArtifactRecordDocument {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly records: ArtifactRecord[];
}

export class ArtifactRecordStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly lock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    const directory = path.join(options.baseDirectory, "artifacts");
    this.filePath = path.join(directory, "records.json");
    this.backupFilePath = path.join(directory, "records.json.bak");
  }

  async read(): Promise<ArtifactRecordDocument> {
    const readResult = await readJsonWithBackupRecovery(
      this.filePath,
      this.backupFilePath,
    );
    if (readResult === null) {
      return { schemaVersion: 1, revision: 1, records: [] };
    }
    const content = readResult.content as Partial<ArtifactRecordDocument>;
    if (content.schemaVersion !== 1 || !Array.isArray(content.records)) {
      throw new DomainError("journal-corrupted", "成果记录文件非法。");
    }
    return {
      schemaVersion: 1,
      revision: typeof content.revision === "number" ? content.revision : 1,
      records: content.records,
    };
  }

  async register(input: {
    projectIdentifier: string;
    missionIdentifier: string;
    taskIdentifier: string;
    sourceAgentInstanceId?: string | null;
    artifactType: string;
    displayName: string;
    location: string;
    contentDigest?: string | null;
  }): Promise<ArtifactRecord> {
    for (const value of [
      input.projectIdentifier,
      input.missionIdentifier,
      input.taskIdentifier,
      input.artifactType,
      input.displayName,
      input.location,
    ]) {
      if (value.trim() === "") {
        throw new DomainError("invalid-task-chain", "成果字段不能为空。");
      }
    }
    return this.lock.runExclusive(async () => {
      const current = await this.read();
      const existing = current.records.find(
        (record) =>
          record.missionIdentifier === input.missionIdentifier &&
          record.taskIdentifier === input.taskIdentifier &&
          record.location === input.location,
      );
      if (existing !== undefined) return existing;
      const record: ArtifactRecord = {
        artifactIdentifier: "artifact-" + String(current.revision),
        projectIdentifier: input.projectIdentifier,
        missionIdentifier: input.missionIdentifier,
        taskIdentifier: input.taskIdentifier,
        sourceAgentInstanceId: input.sourceAgentInstanceId ?? null,
        artifactType: input.artifactType,
        displayName: input.displayName,
        location: input.location,
        createdAtIso: new Date().toISOString(),
        version: 1,
        contentDigest: input.contentDigest ?? null,
        verificationStatus: "unverified",
      };
      const next: ArtifactRecordDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        records: [...current.records, record],
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      return record;
    });
  }

  async verify(input: {
    artifactIdentifier: string;
    status: ArtifactVerificationStatus;
  }): Promise<ArtifactRecord> {
    return this.lock.runExclusive(async () => {
      const current = await this.read();
      const record = current.records.find(
        (candidate) => candidate.artifactIdentifier === input.artifactIdentifier,
      );
      if (record === undefined) {
        throw new DomainError("invalid-task-chain", "成果不存在: " + input.artifactIdentifier);
      }
      const updated: ArtifactRecord = { ...record, verificationStatus: input.status };
      const next: ArtifactRecordDocument = {
        schemaVersion: 1,
        revision: current.revision + 1,
        records: current.records.map((candidate) =>
          candidate.artifactIdentifier === input.artifactIdentifier ? updated : candidate,
        ),
      };
      await writeAtomicJson(this.filePath, next);
      await backupExistingFile(this.filePath, this.backupFilePath);
      return updated;
    });
  }
}

