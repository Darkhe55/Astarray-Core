/**
 * EXEC-01-03（2026-11-09）：**执行记录的持久化与重启对账**。
 *
 * 卡内 §03 要求：
 * - 持久化 queued/running/succeeded/failed/cancelled/timed-out/unknown/rejected 与退出码；
 * - 服务重启先按执行 ID 查询隔离单元并对账，**禁止自动重跑**；
 * - 不确定是否执行过就保持 `unknown`，并**拒绝复用该幂等键**启动新副作用；
 * - 预算、输出游标与执行状态可恢复。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { writeAtomicJson } from "../infra/atomic-json.js";
import type {
  ProcessExecutionRecord,
  ProcessExecutionStore,
} from "./process-execution-controller.js";
import type { ProcessExecutionStatus } from "./execution-contract.js";

const EXECUTION_DIRECTORY_NAME = "process-executions";
const IDEMPOTENCY_INDEX_FILE_NAME = "idempotency-index.json";
const POISONED_KEYS_FILE_NAME = "poisoned-idempotency-keys.json";

interface PersistedIdempotencyIndex {
  readonly schemaVersion: 1;
  readonly executionIdByIdempotencyKey: Record<string, string>;
}

interface PersistedPoisonedKeys {
  readonly schemaVersion: 1;
  readonly poisonedKeys: string[];
}

function idempotencyIndexKey(agentInstanceIdentifier: string, idempotencyKey: string): string {
  return `${agentInstanceIdentifier}\u0000${idempotencyKey}`;
}

/**
 * 文件系统实现：每次执行一个 JSON 文件（原子写），幂等索引与"毒化键"各自一个文件。
 *
 * 为什么"毒化键"要单独持久化：重启后如果某次执行可能已经产生过副作用
 * （状态 `unknown`），同一个幂等键**不能再启动新进程**，否则会重复副作用。
 * 这个事实必须跨重启保留，不能只放在内存里。
 */
export class FileSystemProcessExecutionStore implements ProcessExecutionStore {
  private readonly executionsDirectoryPath: string;
  private readonly idempotencyIndexFilePath: string;
  private readonly poisonedKeysFilePath: string;
  private idempotencyIndexCache: Record<string, string> | null = null;
  private poisonedKeysCache: Set<string> | null = null;

  constructor(options: { readonly stateDirectory: string }) {
    const root = path.join(options.stateDirectory, EXECUTION_DIRECTORY_NAME);
    this.executionsDirectoryPath = root;
    this.idempotencyIndexFilePath = path.join(root, IDEMPOTENCY_INDEX_FILE_NAME);
    this.poisonedKeysFilePath = path.join(root, POISONED_KEYS_FILE_NAME);
  }

  async read(executionId: string): Promise<ProcessExecutionRecord | null> {
    const filePath = this.recordFilePath(executionId);
    let rawText: string;
    try {
      rawText = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    try {
      return JSON.parse(rawText) as ProcessExecutionRecord;
    } catch {
      throw new DomainError(
        "journal-corrupted",
        `执行记录损坏（拒绝按猜测恢复）：${executionId}`,
      );
    }
  }

  async readByIdempotencyKey(input: {
    readonly agentInstanceIdentifier: string;
    readonly idempotencyKey: string;
  }): Promise<ProcessExecutionRecord | null> {
    const index = await this.readIdempotencyIndex();
    const executionId =
      index[idempotencyIndexKey(input.agentInstanceIdentifier, input.idempotencyKey)];
    if (executionId === undefined) return null;
    return this.read(executionId);
  }

  async write(record: ProcessExecutionRecord): Promise<void> {
    await fs.mkdir(this.executionsDirectoryPath, { recursive: true });
    await writeAtomicJson(this.recordFilePath(record.identity.executionId), record);
    const idempotencyKey = record.request.idempotencyKey;
    if (idempotencyKey !== undefined) {
      const index = { ...(await this.readIdempotencyIndex()) };
      const key = idempotencyIndexKey(record.identity.agentInstanceIdentifier, idempotencyKey);
      if (index[key] === undefined) {
        index[key] = record.identity.executionId;
        await this.writeIdempotencyIndex(index);
      }
    }
  }

  /** 列出全部执行记录（重启对账用；损坏文件不静默跳过，直接报错）。 */
  async listAll(): Promise<ProcessExecutionRecord[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.executionsDirectoryPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: ProcessExecutionRecord[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      if (
        fileName === IDEMPOTENCY_INDEX_FILE_NAME ||
        fileName === POISONED_KEYS_FILE_NAME
      ) {
        continue;
      }
      const executionId = fileName.slice(0, -".json".length);
      const record = await this.read(executionId);
      if (record !== null) records.push(record);
    }
    return records;
  }

  /** 毒化幂等键：该键的副作用可能已经发生，禁止再启动新进程。 */
  async poisonIdempotencyKey(input: {
    readonly agentInstanceIdentifier: string;
    readonly idempotencyKey: string;
    readonly reason: string;
  }): Promise<void> {
    const poisonedKeys = new Set(await this.readPoisonedKeys());
    poisonedKeys.add(
      idempotencyIndexKey(input.agentInstanceIdentifier, input.idempotencyKey),
    );
    this.poisonedKeysCache = poisonedKeys;
    await fs.mkdir(this.executionsDirectoryPath, { recursive: true });
    const document: PersistedPoisonedKeys = {
      schemaVersion: 1,
      poisonedKeys: [...poisonedKeys].sort((left, right) => left.localeCompare(right)),
    };
    await writeAtomicJson(this.poisonedKeysFilePath, document);
    void input.reason;
  }

  async isIdempotencyKeyPoisoned(input: {
    readonly agentInstanceIdentifier: string;
    readonly idempotencyKey: string;
  }): Promise<boolean> {
    const poisonedKeys = await this.readPoisonedKeys();
    return poisonedKeys.includes(
      idempotencyIndexKey(input.agentInstanceIdentifier, input.idempotencyKey),
    );
  }

  private recordFilePath(executionId: string): string {
    /** 执行 ID 由本地生成（`exec-<hex>`）；这里仍做字符白名单，避免路径注入。 */
    if (!/^[A-Za-z0-9._-]+$/u.test(executionId)) {
      throw new DomainError(
        "execution-request-invalid",
        `执行标识含非法字符：${executionId}`,
      );
    }
    return path.join(this.executionsDirectoryPath, `${executionId}.json`);
  }

  private async readIdempotencyIndex(): Promise<Record<string, string>> {
    if (this.idempotencyIndexCache !== null) return this.idempotencyIndexCache;
    try {
      const rawText = await fs.readFile(this.idempotencyIndexFilePath, "utf8");
      const document = JSON.parse(rawText) as PersistedIdempotencyIndex;
      this.idempotencyIndexCache = document.executionIdByIdempotencyKey ?? {};
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw new DomainError(
          "journal-corrupted",
          "幂等索引损坏（拒绝按猜测恢复）",
        );
      }
      this.idempotencyIndexCache = {};
    }
    return this.idempotencyIndexCache;
  }

  private async writeIdempotencyIndex(index: Record<string, string>): Promise<void> {
    this.idempotencyIndexCache = index;
    const document: PersistedIdempotencyIndex = {
      schemaVersion: 1,
      executionIdByIdempotencyKey: index,
    };
    await writeAtomicJson(this.idempotencyIndexFilePath, document);
  }

  private async readPoisonedKeys(): Promise<string[]> {
    if (this.poisonedKeysCache !== null) return [...this.poisonedKeysCache];
    try {
      const rawText = await fs.readFile(this.poisonedKeysFilePath, "utf8");
      const document = JSON.parse(rawText) as PersistedPoisonedKeys;
      this.poisonedKeysCache = new Set(document.poisonedKeys ?? []);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw new DomainError(
          "journal-corrupted",
          "毒化幂等键记录损坏（拒绝按猜测恢复）",
        );
      }
      this.poisonedKeysCache = new Set();
    }
    return [...this.poisonedKeysCache];
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** 终态判定（用于重启对账：只有非终态才需要查询隔离单元）。 */
export function isTerminalProcessExecutionStatus(status: ProcessExecutionStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed-out" ||
    status === "rejected"
  );
}

export interface ProcessExecutionReconciliationEntry {
  readonly executionId: string;
  readonly previousStatus: ProcessExecutionStatus;
  readonly nextStatus: ProcessExecutionStatus;
  readonly reason: string;
}

/**
 * 重启对账：逐个非终态执行查询隔离单元，**绝不自动重跑**。
 *
 * 规则：
 * - 隔离单元报告终态 ⇒ 采纳（状态 + 退出码）；
 * - 隔离单元说不知道 / 查询失败 ⇒ 保持 `unknown`，并把该幂等键毒化；
 * - 已有 `unknown` 且带幂等键 ⇒ 同样毒化（重启后再次对账仍不确定）。
 */
export async function reconcileProcessExecutionsAfterRestart(input: {
  readonly store: ProcessExecutionStore & {
    listAll(): Promise<ProcessExecutionRecord[]>;
    poisonIdempotencyKey?(input: {
      readonly agentInstanceIdentifier: string;
      readonly idempotencyKey: string;
      readonly reason: string;
    }): Promise<void>;
  };
  readonly readBackendSnapshot: (
    backendExecutionHandle: string,
  ) => Promise<{
    readonly status: ProcessExecutionStatus;
    readonly exitCode: number | null;
    readonly failureReason: string | null;
  } | null>;
  readonly nowIso?: () => string;
}): Promise<ProcessExecutionReconciliationEntry[]> {
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const entries: ProcessExecutionReconciliationEntry[] = [];
  for (const record of await input.store.listAll()) {
    if (isTerminalProcessExecutionStatus(record.status)) continue;
    const isUncertainAlready = record.status === "unknown";
    const handle = record.backendExecutionHandle;
    const snapshot =
      handle === null ? null : await input.readBackendSnapshot(handle).catch(() => null);
    if (snapshot === null) {
      /** 查不到隔离单元 ⇒ 不猜，保持/转为 unknown，并毒化幂等键。 */
      const nextRecord: ProcessExecutionRecord = {
        ...record,
        status: "unknown",
        failureReason:
          record.failureReason ?? "重启对账：无法确认隔离单元状态（禁止自动重跑）",
        finishedAtIso: record.finishedAtIso ?? nowIso(),
      };
      await input.store.write(nextRecord);
      const idempotencyKey = record.request.idempotencyKey;
      if (idempotencyKey !== undefined && !isUncertainAlready) {
        await input.store.poisonIdempotencyKey?.({
          agentInstanceIdentifier: record.identity.agentInstanceIdentifier,
          idempotencyKey,
          reason: "重启后无法确认是否执行过：禁止复用该幂等键启动新副作用",
        });
      }
      entries.push({
        executionId: record.identity.executionId,
        previousStatus: record.status,
        nextStatus: "unknown",
        reason: "无法确认隔离单元状态",
      });
      continue;
    }
    if (snapshot.status === record.status && snapshot.exitCode === record.exitCode) {
      continue;
    }
    const isTerminal = isTerminalProcessExecutionStatus(snapshot.status);
    const nextRecord: ProcessExecutionRecord = {
      ...record,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
      failureReason: snapshot.failureReason,
      finishedAtIso: isTerminal ? (record.finishedAtIso ?? nowIso()) : record.finishedAtIso,
    };
    await input.store.write(nextRecord);
    entries.push({
      executionId: record.identity.executionId,
      previousStatus: record.status,
      nextStatus: snapshot.status,
      reason: "按隔离单元状态对账",
    });
  }
  return entries;
}
