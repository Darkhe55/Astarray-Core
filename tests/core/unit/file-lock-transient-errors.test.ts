/**
 * F3（2026-11-23）：跨进程文件锁的**瞬时 Windows 错误重试**反例。
 *
 * 背景：并发压测下 `open(..., "wx")` 偶发 `EPERM`（隔离复跑不出现），
 * 旧实现把它当真实失败直接抛出 ⇒ 并发用例偶发翻红。新语义：
 * 瞬时错误按锁冲突同样等待重试；超过期限才报 `lock-timeout`。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withFileLock } from "../../../packages/core/src/infra/file-lock.js";

let baseDirectory: string;
let lockFilePath: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lock-"));
  lockFilePath = path.join(baseDirectory, "state.lock");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function permissiveError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

describe("F3：文件锁瞬时错误重试", () => {
  it("① EPERM 一次后成功 ⇒ 动作执行且锁被释放", async () => {
    const originalOpen = fs.open.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      calls += 1;
      if (calls === 1) {
        throw permissiveError("EPERM");
      }
      return originalOpen(...args);
    });
    try {
      const result = await withFileLock({ lockFilePath, timeoutMilliseconds: 1_000 }, async () => 42);
      expect(result).toBe(42);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(spy).toHaveBeenCalled();
      await expect(fs.access(lockFilePath)).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("② EACCES/EBUSY 同样重试", async () => {
    const originalOpen = fs.open.bind(fs);
    const codes = ["EACCES", "EBUSY"];
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const next = codes.shift();
      if (next !== undefined) {
        throw permissiveError(next);
      }
      return originalOpen(...args);
    });
    try {
      expect(
        await withFileLock({ lockFilePath, timeoutMilliseconds: 1_000 }, async () => "ok"),
      ).toBe("ok");
    } finally {
      spy.mockRestore();
    }
  });

  it("③ 持续 EPERM ⇒ 超过期限报 lock-timeout（不无限等待、不静默）", async () => {
    const spy = vi.spyOn(fs, "open").mockRejectedValue(permissiveError("EPERM"));
    try {
      await expect(
        withFileLock({ lockFilePath, timeoutMilliseconds: 80 }, async () => "never"),
      ).rejects.toMatchObject({ errorCode: "lock-timeout" });
    } finally {
      spy.mockRestore();
    }
  });

  it("④ 非瞬时错误（如 ENOSPC）⇒ 立即抛出，不伪装成超时", async () => {
    const spy = vi.spyOn(fs, "open").mockRejectedValue(permissiveError("ENOSPC"));
    try {
      await expect(
        withFileLock({ lockFilePath, timeoutMilliseconds: 1_000 }, async () => "never"),
      ).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      spy.mockRestore();
    }
  });
});
