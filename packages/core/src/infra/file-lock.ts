/**
 * 跨进程文件锁（2026-11-18）。
 *
 * 背景：`TaskStore` / 台账的互斥锁只在**单实例**内有效。两个进程（或重建的实例）
 * 同时"读-改-写"同一份文档会丢更新，或触发 `stale-revision` 之类的伪冲突。
 *
 * 做法：创建锁文件（`open(..., "wx")` 原子创建）→ 释放时删除。
 * - 冲突时短暂等待并重试，超时抛 `lock-timeout`（真实错误，不静默）；
 * - 锁文件超过 stale 阈值视为**持有者已死**，删除后重试；
 * - 锁文件只含持有者标识与时间戳，**不含用户内容**，删除无数据风险。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DomainError } from "../core/errors.js";

export interface FileLockOptions {
  readonly lockFilePath: string;
  /** 获取锁的最长等待时间（毫秒）。 */
  readonly timeoutMilliseconds?: number;
  /** 超过该时长的锁视为陈旧（毫秒）。 */
  readonly staleLockMilliseconds?: number;
}

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_STALE_LOCK_MILLISECONDS = 30_000;
const RETRY_INTERVAL_MILLISECONDS = 20;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withFileLock<T>(
  options: FileLockOptions,
  action: () => Promise<T>,
): Promise<T> {
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  const staleLockMilliseconds =
    options.staleLockMilliseconds ?? DEFAULT_STALE_LOCK_MILLISECONDS;
  const deadline = Date.now() + timeoutMilliseconds;
  const ownerText = `${process.pid}@${os.hostname()}`;
  /** 锁文件所在目录可能尚未创建（首次写入就是这种情况）。 */
  await fs.mkdir(path.dirname(options.lockFilePath), { recursive: true });

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  while (handle === null) {
    try {
      handle = await fs.open(options.lockFilePath, "wx");
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      /**
       * Windows 上 `open(..., "wx")` 在另一进程**创建/释放的瞬间**可能短暂返回
       * `EPERM`/`EACCES`/`EBUSY`（实测：并发压测下偶发，隔离复跑不出现）。
       * 这些是**可重试**的瞬时错误：按锁冲突同等等待，超时才报 `lock-timeout`
       * （不把瞬时竞争伪装成真实失败，也不无限等待）。
       */
      const isTransientWindowsCode =
        errorCode === "EPERM" || errorCode === "EACCES" || errorCode === "EBUSY";
      if (errorCode !== "EEXIST" && !isTransientWindowsCode) {
        throw error;
      }
      if (isTransientWindowsCode) {
        if (Date.now() >= deadline) {
          throw new DomainError(
            "lock-timeout",
            `获取文件锁超时（${timeoutMilliseconds}ms）: ${options.lockFilePath}（最后错误 ${String(errorCode)}）`,
          );
        }
        await delay(RETRY_INTERVAL_MILLISECONDS);
        continue;
      }
      /** 陈旧锁：持有者已死 ⇒ 删除后重试（删除的只是锁文件本身）。 */
      const lockStats = await fs.stat(options.lockFilePath).catch(() => null);
      if (
        lockStats !== null &&
        Date.now() - lockStats.mtimeMs > staleLockMilliseconds
      ) {
        await fs.unlink(options.lockFilePath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new DomainError(
          "lock-timeout",
          `获取文件锁超时（${timeoutMilliseconds}ms）: ${options.lockFilePath}`,
        );
      }
      await delay(RETRY_INTERVAL_MILLISECONDS);
    }
  }

  try {
    await handle.writeFile(`${ownerText} ${new Date().toISOString()}`, "utf8");
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(options.lockFilePath).catch(() => undefined);
  }
}
