/**
 * 确定性磁盘缓存（T09 / ADR-0005；AUDIT-REPAIR-01 检查点 03 收紧）。
 *
 * 只缓存"确定性、无副作用、已通过当前权限/作用域/敏感检查"的读取结果。
 *
 * 本检查点**不把缓存接进模型执行链**：组件先可安全接入，生产接线留待 04 核查。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { writeAtomicJson } from "./atomic-json.js";

export const CACHE_ENTRY_SCHEMA_VERSION = 1;
/** 保守默认：5 分钟。0 表示禁用读取和写入。 */
export const DEFAULT_MAXIMUM_ENTRY_AGE_MILLISECONDS = 300_000;

export type CacheStatus = "hit" | "miss" | "bypass" | "stale-reject";

/** 缓存键只接受 64 位十六进制摘要（拒绝路径穿越/任意文件名）。 */
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/u;

export interface CacheKeyParts {
  provider: string;
  model: string;
  mode: "ponder" | "assist" | "devolve";
  systemPromptHash: string;
  inputText: string;
  toolSubsetHash: string;
  contextSummaryHash: string;
  /** 相关文件指纹（内容哈希）。 */
  fileFingerprint: string;
  /** 隔离字段（AUDIT-REPAIR-01）：缺任一必填字段即 bypass，禁止共享身份默认值。 */
  projectIdentifier: string;
  agentInstanceId: string;
  permissionProfileId: string;
  permissionRevision: number;
  toolImplementationVersion: string;
  cacheSchemaVersion: number;
}

export interface CacheEntry {
  schemaVersion: number;
  key: string;
  cachedAtIso: string;
  expiresAtIso: string;
  resultText: string;
  estimatedTokenCount: number;
  fileFingerprint: string;
}

export interface CacheBypassCriteria {
  isWriteOperation: boolean;
  isTimeSensitive: boolean;
  isFailedResult: boolean;
  /** 敏感内容（命中敏感策略）不得缓存。 */
  isSensitiveContent?: boolean;
  /** 工具调用指令不得缓存。 */
  isToolInstruction?: boolean;
}

export class CacheKeyBuilder {
  static buildKey(parts: CacheKeyParts): string {
    const bypass = CacheKeyBuilder.findBypassReason(parts);
    if (bypass !== null) {
      throw new DomainError("cache-key-incomplete", bypass);
    }
    const canonical = JSON.stringify({
      provider: parts.provider,
      model: parts.model,
      mode: parts.mode,
      systemPromptHash: parts.systemPromptHash,
      inputText: parts.inputText,
      toolSubsetHash: parts.toolSubsetHash,
      contextSummaryHash: parts.contextSummaryHash,
      fileFingerprint: parts.fileFingerprint,
      projectIdentifier: parts.projectIdentifier,
      agentInstanceId: parts.agentInstanceId,
      permissionProfileId: parts.permissionProfileId,
      permissionRevision: parts.permissionRevision,
      toolImplementationVersion: parts.toolImplementationVersion,
      cacheSchemaVersion: parts.cacheSchemaVersion,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** 缺必填隔离字段/非法 revision ⇒ 返回 bypass 原因（调用方不缓存）。 */
  static findBypassReason(parts: CacheKeyParts): string | null {
    const requiredIdentifiers: Array<[string, unknown]> = [
      ["provider", parts.provider],
      ["model", parts.model],
      ["projectIdentifier", parts.projectIdentifier],
      ["agentInstanceId", parts.agentInstanceId],
      ["permissionProfileId", parts.permissionProfileId],
      ["toolImplementationVersion", parts.toolImplementationVersion],
    ];
    for (const [fieldName, value] of requiredIdentifiers) {
      if (typeof value !== "string" || value.trim() === "") {
        return `缓存键缺少必填隔离字段: ${fieldName}`;
      }
    }
    if (
      !Number.isInteger(parts.permissionRevision) ||
      parts.permissionRevision < 0
    ) {
      return "缓存键的 permissionRevision 必须是非负整数";
    }
    if (!Number.isInteger(parts.cacheSchemaVersion) || parts.cacheSchemaVersion < 1) {
      return "缓存键的 cacheSchemaVersion 必须是正整数";
    }
    return null;
  }

  static shouldBypass(criteria: CacheBypassCriteria): boolean {
    return (
      criteria.isWriteOperation ||
      criteria.isTimeSensitive ||
      criteria.isFailedResult ||
      criteria.isSensitiveContent === true ||
      criteria.isToolInstruction === true
    );
  }
}

export interface DiskCacheOptions {
  maximumEntryAgeMilliseconds?: number;
  /** 可注入时钟（毫秒）；测试不得使用真实 sleep。 */
  nowMilliseconds?: () => number;
}

export class DiskCache {
  private readonly cacheDirectoryPath: string;
  private readonly maximumEntryAgeMilliseconds: number;
  private readonly nowMilliseconds: () => number;

  constructor(baseDirectory: string, options: DiskCacheOptions = {}) {
    this.cacheDirectoryPath = path.join(baseDirectory, "cache");
    const maximumEntryAgeMilliseconds =
      options.maximumEntryAgeMilliseconds ??
      DEFAULT_MAXIMUM_ENTRY_AGE_MILLISECONDS;
    if (
      typeof maximumEntryAgeMilliseconds !== "number" ||
      !Number.isFinite(maximumEntryAgeMilliseconds) ||
      maximumEntryAgeMilliseconds < 0
    ) {
      throw new DomainError(
        "invalid-cache-configuration",
        "maximumEntryAgeMilliseconds 必须是非负有限数（0 表示禁用缓存）。",
      );
    }
    this.maximumEntryAgeMilliseconds = maximumEntryAgeMilliseconds;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
  }

  get isEnabled(): boolean {
    return this.maximumEntryAgeMilliseconds > 0;
  }

  /**
   * 读取缓存。
   *
   * - `currentFileFingerprint === null` ⇒ 指纹不可用 ⇒ bypass（不得共享空指纹）；
   * - `authorizeRead` 返回 false ⇒ bypass（命中也不能绕过当前权限/敏感检查）。
   */
  async get(
    key: string,
    currentFileFingerprint: string | null,
    options: { authorizeRead?: () => Promise<boolean> | boolean } = {},
  ): Promise<{ status: CacheStatus; entry: CacheEntry | null }> {
    if (!this.isEnabled) {
      return { status: "bypass", entry: null };
    }
    if (!CACHE_KEY_PATTERN.test(key)) {
      return { status: "bypass", entry: null };
    }
    if (currentFileFingerprint === null || currentFileFingerprint === "") {
      return { status: "bypass", entry: null };
    }
    if (options.authorizeRead !== undefined) {
      const isAuthorized = await options.authorizeRead();
      if (!isAuthorized) {
        return { status: "bypass", entry: null };
      }
    }
    const entry = await this.readEntry(key);
    if (entry.kind === "miss") {
      return { status: "miss", entry: null };
    }
    if (entry.kind === "stale") {
      return { status: "stale-reject", entry: null };
    }
    if (entry.entry.fileFingerprint !== currentFileFingerprint) {
      return { status: "stale-reject", entry: null };
    }
    return { status: "hit", entry: entry.entry };
  }

  async put(entry: CacheEntry): Promise<void> {
    if (!this.isEnabled) return;
    if (!CACHE_KEY_PATTERN.test(entry.key)) {
      throw new DomainError(
        "invalid-cache-key",
        "缓存键必须是 64 位十六进制摘要（拒绝路径穿越）。",
      );
    }
    if (entry.schemaVersion !== CACHE_ENTRY_SCHEMA_VERSION) {
      throw new DomainError(
        "invalid-cache-entry",
        "缓存条目 schemaVersion 与当前版本不一致：拒绝写入。",
      );
    }
    const nowMilliseconds = this.nowMilliseconds();
    const expiresAtMilliseconds =
      nowMilliseconds + this.maximumEntryAgeMilliseconds;
    const normalized: CacheEntry = {
      ...entry,
      cachedAtIso: new Date(nowMilliseconds).toISOString(),
      expiresAtIso: new Date(expiresAtMilliseconds).toISOString(),
    };
    await writeAtomicJson(this.entryFilePath(entry.key), normalized);
  }

  private async readEntry(
    key: string,
  ): Promise<
    | { readonly kind: "miss" }
    | { readonly kind: "stale" }
    | { readonly kind: "valid"; readonly entry: CacheEntry }
  > {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.entryFilePath(key), "utf8"));
    } catch {
      return { kind: "miss" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "miss" };
    }
    const entry = parsed as Partial<CacheEntry>;
    if (
      entry.schemaVersion !== CACHE_ENTRY_SCHEMA_VERSION ||
      entry.key !== key ||
      typeof entry.resultText !== "string" ||
      typeof entry.fileFingerprint !== "string" ||
      typeof entry.estimatedTokenCount !== "number"
    ) {
      /** 旧格式/损坏/键不一致 ⇒ miss，不做猜测迁移。 */
      return { kind: "miss" };
    }
    const nowMilliseconds = this.nowMilliseconds();
    const cachedAtMilliseconds = Date.parse(String(entry.cachedAtIso));
    const expiresAtMilliseconds = Date.parse(String(entry.expiresAtIso));
    if (
      !Number.isFinite(cachedAtMilliseconds) ||
      !Number.isFinite(expiresAtMilliseconds)
    ) {
      return { kind: "miss" };
    }
    /** cachedAtIso 不在未来（时钟回拨/伪造）；当前时间严格早于过期时间。 */
    if (cachedAtMilliseconds > nowMilliseconds) {
      return { kind: "stale" };
    }
    if (nowMilliseconds >= expiresAtMilliseconds) {
      return { kind: "stale" };
    }
    /** 实际年龄不得超过当前配置上限（配置缩短后旧条目立即失效）。 */
    if (nowMilliseconds - cachedAtMilliseconds >= this.maximumEntryAgeMilliseconds) {
      return { kind: "stale" };
    }
    return { kind: "valid", entry: entry as CacheEntry };
  }

  private entryFilePath(key: string): string {
    return path.join(this.cacheDirectoryPath, `${key}.json`);
  }
}

/** 计算文件内容指纹（sha256 前缀 16 位）；仅供仍需要字符串的调用方。 */
export async function computeFileFingerprint(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/**
 * 指纹读取的可判读版本：失败返回 `unavailable`，而不是空字符串。
 * 空串会把不同失败输入当成同一资源，缓存必须 bypass。
 */
export async function readFileFingerprintOrUnavailable(
  filePath: string,
): Promise<
  { readonly status: "available"; readonly fingerprint: string } | { readonly status: "unavailable" }
> {
  try {
    const content = await fs.readFile(filePath);
    return {
      status: "available",
      fingerprint: createHash("sha256").update(content).digest("hex").slice(0, 16),
    };
  } catch {
    return { status: "unavailable" };
  }
}
