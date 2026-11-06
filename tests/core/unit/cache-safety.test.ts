/**
 * AUDIT-REPAIR-01 检查点 03（2026-11-06）：确定性磁盘缓存的安全边界与 TTL。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CACHE_ENTRY_SCHEMA_VERSION,
  CacheKeyBuilder,
  DiskCache,
  readFileFingerprintOrUnavailable,
} from "../../../packages/core/src/infra/cache.js";
import type { CacheKeyParts } from "../../../packages/core/src/infra/cache.js";

let directory: string;
const START = Date.parse("2026-11-06T10:00:00.000Z");

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cache-safety-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
});

function parts(overrides: Partial<CacheKeyParts> = {}): CacheKeyParts {
  return {
    provider: "openai",
    model: "m",
    mode: "assist",
    systemPromptHash: "s",
    inputText: "i",
    toolSubsetHash: "t",
    contextSummaryHash: "c",
    fileFingerprint: "fp",
    projectIdentifier: "project-a",
    agentInstanceId: "agent-1",
    permissionProfileId: "assist",
    permissionRevision: 1,
    toolImplementationVersion: "v1",
    cacheSchemaVersion: 1,
    ...overrides,
  };
}

function entry(key: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CACHE_ENTRY_SCHEMA_VERSION,
    key,
    cachedAtIso: new Date(START).toISOString(),
    expiresAtIso: new Date(START + 1_000).toISOString(),
    resultText: "结果",
    estimatedTokenCount: 1,
    fileFingerprint: "fp",
    ...overrides,
  };
}

describe("缓存 TTL 与时钟", () => {
  it("到期前命中；恰好到期/之后 stale-reject", async () => {
    const key = CacheKeyBuilder.buildKey(parts());
    const ttl = { maximumEntryAgeMilliseconds: 1_000 };
    await new DiskCache(directory, { ...ttl, nowMilliseconds: () => START }).put(entry(key));

    const before = await new DiskCache(directory, { ...ttl, nowMilliseconds: () => START + 999 }).get(key, "fp");
    expect(before.status).toBe("hit");

    const exact = await new DiskCache(directory, { ...ttl, nowMilliseconds: () => START + 1_000 }).get(key, "fp");
    expect(exact.status).toBe("stale-reject");

    const after = await new DiskCache(directory, { ...ttl, nowMilliseconds: () => START + 1_001 }).get(key, "fp");
    expect(after.status).toBe("stale-reject");
  });

  it("时钟回拨（cachedAt 在未来）⇒ stale-reject", async () => {
    const key = CacheKeyBuilder.buildKey(parts());
    await new DiskCache(directory, { nowMilliseconds: () => START }).put(entry(key));
    const rolledBack = await new DiskCache(directory, { nowMilliseconds: () => START - 1 }).get(key, "fp");
    expect(rolledBack.status).toBe("stale-reject");
  });

  it("配置缩短后旧条目立即失效", async () => {
    const key = CacheKeyBuilder.buildKey(parts());
    await new DiskCache(directory, {
      maximumEntryAgeMilliseconds: 300_000,
      nowMilliseconds: () => START,
    }).put(entry(key));
    const shortened = await new DiskCache(directory, {
      maximumEntryAgeMilliseconds: 1_000,
      nowMilliseconds: () => START + 5_000,
    }).get(key, "fp");
    expect(shortened.status).toBe("stale-reject");
  });

  it("TTL=0 禁用读写；非法配置拒绝", async () => {
    const key = CacheKeyBuilder.buildKey(parts());
    const disabled = new DiskCache(directory, { maximumEntryAgeMilliseconds: 0 });
    expect(disabled.isEnabled).toBe(false);
    await disabled.put(entry(key));
    await expect(fs.access(path.join(directory, "cache", `${key}.json`))).rejects.toThrow();
    expect((await disabled.get(key, "fp")).status).toBe("bypass");

    expect(() => new DiskCache(directory, { maximumEntryAgeMilliseconds: -1 })).toThrow(/非负/u);
    expect(() => new DiskCache(directory, { maximumEntryAgeMilliseconds: Number.NaN })).toThrow(/非负/u);
    expect(() => new DiskCache(directory, { maximumEntryAgeMilliseconds: Number.POSITIVE_INFINITY })).toThrow(/非负/u);
  });
});

describe("缓存键隔离与入口校验", () => {
  it("身份/项目/profile/revision/工具版本/schema 任一不同 ⇒ 不同 key", () => {
    const base = CacheKeyBuilder.buildKey(parts());
    for (const override of [
      { projectIdentifier: "project-b" },
      { agentInstanceId: "agent-2" },
      { permissionProfileId: "devolve" },
      { permissionRevision: 2 },
      { toolImplementationVersion: "v2" },
      { cacheSchemaVersion: 2 },
    ]) {
      expect(CacheKeyBuilder.buildKey(parts(override))).not.toBe(base);
    }
  });

  it("缺必填隔离字段 ⇒ 明确 bypass 原因；buildKey 抛错", () => {
    const reason = CacheKeyBuilder.findBypassReason(
      parts({ projectIdentifier: "" }),
    );
    expect(reason).toContain("projectIdentifier");
    expect(() => CacheKeyBuilder.buildKey(parts({ permissionRevision: -1 }))).toThrow(
      /permissionRevision/u,
    );
    expect(() => CacheKeyBuilder.buildKey(parts({ agentInstanceId: "" }))).toThrow(
      /agentInstanceId/u,
    );
  });

  it("非十六进制/路径穿越 key ⇒ bypass；写入拒绝", async () => {
    const cache = new DiskCache(directory, { nowMilliseconds: () => START });
    expect((await cache.get("../../etc/passwd", "fp")).status).toBe("bypass");
    await expect(cache.put(entry("../escape"))).rejects.toMatchObject({
      errorCode: "invalid-cache-key",
    });
  });

  it("旧格式/损坏/键不一致 ⇒ miss；错误 schema 拒绝写入", async () => {
    const key = CacheKeyBuilder.buildKey(parts());
    const cache = new DiskCache(directory, { nowMilliseconds: () => START });
    await fs.mkdir(path.join(directory, "cache"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "cache", `${key}.json`),
      JSON.stringify({ key, resultText: "旧", estimatedTokenCount: 1, fileFingerprint: "fp" }),
      "utf8",
    );
    expect((await cache.get(key, "fp")).status).toBe("miss");

    await fs.writeFile(
      path.join(directory, "cache", `${key}.json`),
      JSON.stringify(entry("a".repeat(64))),
      "utf8",
    );
    expect((await cache.get(key, "fp")).status).toBe("miss");

    await expect(cache.put(entry(key, { schemaVersion: 99 }))).rejects.toMatchObject({
      errorCode: "invalid-cache-entry",
    });
  });
});

describe("缓存读取门禁与 bypass 条件", () => {
  it("authorizeRead=false ⇒ bypass（命中也不能绕过权限）", async () => {
    const key = CacheKeyBuilder.buildKey(parts());
    await new DiskCache(directory, { nowMilliseconds: () => START }).put(entry(key));
    const denied = await new DiskCache(directory, { nowMilliseconds: () => START }).get(key, "fp", {
      authorizeRead: () => false,
    });
    expect(denied.status).toBe("bypass");
    const allowed = await new DiskCache(directory, { nowMilliseconds: () => START }).get(key, "fp", {
      authorizeRead: () => true,
    });
    expect(allowed.status).toBe("hit");
  });

  it("指纹不可用 ⇒ bypass；读取失败返回 unavailable", async () => {
    const key = CacheKeyBuilder.buildKey(parts());
    await new DiskCache(directory, { nowMilliseconds: () => START }).put(entry(key));
    const cache = new DiskCache(directory, { nowMilliseconds: () => START });
    expect((await cache.get(key, null)).status).toBe("bypass");
    expect((await cache.get(key, "")).status).toBe("bypass");

    const missing = await readFileFingerprintOrUnavailable(
      path.join(directory, "missing.txt"),
    );
    expect(missing.status).toBe("unavailable");

    const filePath = path.join(directory, "data.txt");
    await fs.writeFile(filePath, "内容", "utf8");
    const available = await readFileFingerprintOrUnavailable(filePath);
    expect(available.status).toBe("available");
  });

  it("写/时间敏感/失败/敏感内容/工具指令 ⇒ bypass", () => {
    const base = {
      isWriteOperation: false,
      isTimeSensitive: false,
      isFailedResult: false,
    };
    expect(CacheKeyBuilder.shouldBypass({ ...base })).toBe(false);
    expect(CacheKeyBuilder.shouldBypass({ ...base, isSensitiveContent: true })).toBe(true);
    expect(CacheKeyBuilder.shouldBypass({ ...base, isToolInstruction: true })).toBe(true);
  });
});
