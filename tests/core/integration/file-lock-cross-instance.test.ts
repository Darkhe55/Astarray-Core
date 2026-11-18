/**
 * 跨进程文件锁（2026-11-18）：**两个实例并发读-改-写不能丢更新**。
 *
 * 进程内互斥锁（`AsyncMutex`）各管各的：两个 `TaskStore` 实例同时更新同一条任务链时，
 * 没有文件锁就会互相覆盖。这里用两个**独立实例**模拟两个进程。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withFileLock } from "../../../packages/core/src/infra/file-lock.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";

vi.setConfig({ testTimeout: 120_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "file-lock-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): TaskStore {
  return new TaskStore({ baseDirectory: stateDirectory });
}

describe("跨进程文件锁", () => {
  it("① 锁被占用时后来的调用要等待，不会同时进入临界区", async () => {
    const lockFilePath = path.join(stateDirectory, "counter.lock");
    const events: string[] = [];
    const firstTask = withFileLock({ lockFilePath }, async () => {
      events.push("first-enter");
      await new Promise((resolve) => setTimeout(resolve, 120));
      events.push("first-exit");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondTask = withFileLock({ lockFilePath }, async () => {
      events.push("second-enter");
    });
    await Promise.all([firstTask, secondTask]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  }, 60_000);

  it("② 陈旧锁（持有者已死）会被清理，后续调用不被永久卡住", async () => {
    const lockFilePath = path.join(stateDirectory, "stale.lock");
    await fs.writeFile(lockFilePath, "dead-owner", "utf8");
    /** 把 mtime 改到过去，模拟陈旧锁。 */
    const oldSeconds = Math.floor(Date.now() / 1000) - 120;
    await fs.utimes(lockFilePath, oldSeconds, oldSeconds);
    const entered = await withFileLock(
      { lockFilePath, staleLockMilliseconds: 1_000 },
      async () => "entered",
    );
    expect(entered).toBe("entered");
  }, 60_000);

  it("③ 两个实例并发更新同一条任务链：40 次更新全部生效，无丢更新", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    await firstStore.writeTaskChain({
      schemaVersion: 1,
      missionId: "mission-1",
      revision: 1,
      updatedAtIso: "2026-11-18T00:00:00.000Z",
      tasks: [
        {
          id: "T-001",
          description: "执行",
          dependsOn: [],
          taskType: "data",
          toolNames: [],
          assignedAgentId: null,
          status: "running",
          resultLocation: null,
        },
      ],
    } as never);

    const update = async (store: TaskStore): Promise<void> => {
      await store.updateTaskChain("mission-1", (current) => {
        if (current === null) {
          throw new Error("任务链必须存在");
        }
        return { ...current, revision: current.revision + 1 };
      });
    };

    const updates: Promise<void>[] = [];
    for (let index = 0; index < 20; index += 1) {
      updates.push(update(firstStore), update(secondStore));
    }
    await Promise.all(updates);

    const finalChain = await buildStore().readTaskChain("mission-1");
    /** 初始 1 + 40 次更新。丢一次更新都会小于 41。 */
    expect(finalChain?.revision).toBe(41);
  }, 120_000);
});
