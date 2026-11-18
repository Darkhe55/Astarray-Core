/**
 * 真实跨进程锁验证的**子进程 worker**（2026-11-18）。
 *
 * 由 `scripts/verify-cross-process-file-lock.mjs` 通过 **独立的 vitest 进程** 启动；
 * 正常情况下（未设置 `CROSS_PROCESS_LOCK_STATE_DIR`）跳过，不进入全量门禁。
 *
 * 每个子进程对同一任务链做 20 次读-改-写；父进程断言最终 revision=41。
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { TaskStore } from "../../packages/core/src/infra/task-store.js";

vi.setConfig({ testTimeout: 120_000 });

const stateDirectory = process.env.CROSS_PROCESS_LOCK_STATE_DIR ?? "";

describe.skipIf(stateDirectory === "")("跨进程 worker", () => {
  afterAll(async () => {
    /** 不清理状态目录：父进程负责断言与清理。 */
  });

  it("对同一任务链做 20 次更新", async () => {
    const store = new TaskStore({ baseDirectory: stateDirectory });
    for (let index = 0; index < 20; index += 1) {
      await store.updateTaskChain("mission-1", (current) => {
        if (current === null) {
          throw new Error("任务链必须存在");
        }
        return { ...current, revision: current.revision + 1 };
      });
    }
    const chain = await store.readTaskChain("mission-1");
    expect(chain?.revision).toBeGreaterThan(1);
  }, 120_000);
});
