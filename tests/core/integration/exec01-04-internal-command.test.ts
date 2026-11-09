/**
 * EXEC-01-04（2026-11-09）：内部命令异步执行的**反例优先**验证。
 *
 * 要证的三件事：
 * 1. 慢命令执行期间**事件循环不被阻塞**（并发任务能继续推进）——这正是
 *    `spawnSync` 的问题所在；
 * 2. 超时与取消都**真的终止进程**并如实标记（不把被杀说成"失败但原因未知"）；
 * 3. 失败时保留退出码与 stderr 尾部证据（不再只用 boolean 隐藏原因）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  INTERNAL_COMMAND_DIAGNOSTIC_TAIL_CHARACTERS,
  runInternalCommandAsync,
} from "../../../packages/core/src/orchestration/internal-command-runner.js";

/** RELIABILITY-01：本文件真的起子进程 ⇒ 必须显式给出超时预算。 */
vi.setConfig({ testTimeout: 60_000 });

describe("EXEC-01-04 内部命令：成功与失败都保留证据", () => {
  it("成功命令 ⇒ isSuccessful、退出码 0", async () => {
    const outcome = await runInternalCommandAsync({
      command: 'node -e "process.stdout.write(\'ok\')"',
      workingDirectoryPath: process.cwd(),
      timeoutMilliseconds: 30_000,
    });
    expect(outcome.isSuccessful).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdoutTail).toContain("ok");
    expect(outcome.failureReason).toBeNull();
    expect(outcome.isolationLevelDescription).toContain("非沙箱");
  });

  it("失败命令 ⇒ 保留退出码与 stderr 尾部（不再只有 boolean）", async () => {
    const outcome = await runInternalCommandAsync({
      command: 'node -e "process.stderr.write(\'boom\'); process.exit(3)"',
      workingDirectoryPath: process.cwd(),
      timeoutMilliseconds: 30_000,
    });
    expect(outcome.isSuccessful).toBe(false);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderrTail).toContain("boom");
    expect(outcome.failureReason).toContain("退出码 3");
  });

  it("诊断输出被截断（不把整份日志堆进内存）", async () => {
    const outcome = await runInternalCommandAsync({
      command:
        'node -e "process.stdout.write(\'x\'.repeat(20000))"',
      workingDirectoryPath: process.cwd(),
      timeoutMilliseconds: 30_000,
    });
    expect(outcome.stdoutTail.length).toBeLessThanOrEqual(
      INTERNAL_COMMAND_DIAGNOSTIC_TAIL_CHARACTERS,
    );
  });
});

describe("EXEC-01-04 内部命令：超时与取消真的终止", () => {
  it("超时 ⇒ 标记 isTimedOut 且原因含超时毫秒数", async () => {
    const startedAtMilliseconds = Date.now();
    const outcome = await runInternalCommandAsync({
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      workingDirectoryPath: process.cwd(),
      timeoutMilliseconds: 400,
    });
    const elapsedMilliseconds = Date.now() - startedAtMilliseconds;
    expect(outcome.isSuccessful).toBe(false);
    expect(outcome.isTimedOut).toBe(true);
    expect(outcome.failureReason).toContain("超时");
    /** 真的被终止：不应等到 60s。 */
    expect(elapsedMilliseconds).toBeLessThan(20_000);
  });

  it("取消 ⇒ 标记 isCancelled，且在取消信号触发后很快返回", async () => {
    const controller = new AbortController();
    const startedAtMilliseconds = Date.now();
    const running = runInternalCommandAsync({
      command: 'node -e "setTimeout(()=>{}, 60000)"',
      workingDirectoryPath: process.cwd(),
      timeoutMilliseconds: 30_000,
      cancellationSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const outcome = await running;
    expect(outcome.isSuccessful).toBe(false);
    expect(outcome.isCancelled).toBe(true);
    expect(outcome.failureReason).toContain("取消");
    expect(Date.now() - startedAtMilliseconds).toBeLessThan(20_000);
  });

  it("执行前已取消 ⇒ 不启动进程，直接返回取消", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runInternalCommandAsync({
      command: 'node -e "process.exit(0)"',
      workingDirectoryPath: process.cwd(),
      timeoutMilliseconds: 30_000,
      cancellationSignal: controller.signal,
    });
    expect(outcome.isCancelled).toBe(true);
    expect(outcome.failureReason).toContain("执行前已被取消");
  });
});

describe("EXEC-01-04 内部命令：不阻塞事件循环", () => {
  it("慢命令期间并发定时器照常推进（spawnSync 会卡住这里）", async () => {
    let timerTickCount = 0;
    const intervalHandle = setInterval(() => {
      timerTickCount += 1;
    }, 25);
    try {
      const running = runInternalCommandAsync({
        command: 'node -e "setTimeout(()=>{}, 1200)"',
        workingDirectoryPath: process.cwd(),
        timeoutMilliseconds: 30_000,
      });
      /** 在命令执行期间观察：定时器应当持续触发。 */
      await new Promise((resolve) => setTimeout(resolve, 800));
      const ticksDuringCommand = timerTickCount;
      const outcome = await running;
      expect(outcome.isSuccessful).toBe(true);
      /**
       * 800ms / 25ms ≈ 32 次；保守要求 ≥ 10 次即足以证伪"同步阻塞"
       * （spawnSync 期间这里会接近 0）。
       */
      expect(ticksDuringCommand).toBeGreaterThanOrEqual(10);
    } finally {
      clearInterval(intervalHandle);
    }
  });
});
