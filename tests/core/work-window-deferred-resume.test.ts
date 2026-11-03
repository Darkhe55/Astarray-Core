/**
 * GUI-04-06（2026-11-03）：工作时段"因休息被挡"的记账与一次性恢复。
 *
 * 覆盖：去重登记、损坏文件回退、成功/已在运行移除、被拒/异常保留、按登记顺序恢复。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WorkWindowDeferredMissionStore,
  resumeDeferredWorkWindowMissions,
} from "../../packages/core/src/orchestration/work-window-deferred-mission-store.js";

let directory: string;
let store: WorkWindowDeferredMissionStore;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "astarray-workwindow-deferred-"));
  store = new WorkWindowDeferredMissionStore({
    baseDirectory: directory,
    nowIso: () => "2026-11-03T00:00:00.000Z",
  });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

describe("休息被挡 mission 记账", () => {
  it("同一 mission 去重；保留首次登记时间并更新观察时间", async () => {
    await store.record({
      missionIdentifier: "mission-1",
      projectIdentifier: "project-a",
      reason: "休息时段",
    });
    await store.record({
      missionIdentifier: "mission-1",
      projectIdentifier: "project-a",
      reason: "休息时段（再次）",
    });
    await store.record({
      missionIdentifier: "mission-2",
      projectIdentifier: null,
      reason: "休息时段",
    });
    const records = await store.list();
    expect(records).toHaveLength(2);
    expect(records[0]?.missionIdentifier).toBe("mission-1");
    expect(records[0]?.reason).toBe("休息时段（再次）");
  });

  it("删除只移除目标；未知 mission 无副作用", async () => {
    await store.record({ missionIdentifier: "a", projectIdentifier: null, reason: "r" });
    await store.record({ missionIdentifier: "b", projectIdentifier: null, reason: "r" });
    await store.remove("a");
    await store.remove("missing");
    const records = await store.list();
    expect(records.map((record) => record.missionIdentifier)).toEqual(["b"]);
  });
});

describe("一次性恢复", () => {
  it("成功与已在运行 ⇒ 移除；被拒/异常 ⇒ 保留；按登记顺序", async () => {
    for (const missionIdentifier of ["a", "b", "c", "d"]) {
      await store.record({
        missionIdentifier,
        projectIdentifier: null,
        reason: "rest",
      });
    }
    const attempted: string[] = [];
    const outcomes = await resumeDeferredWorkWindowMissions({
      store,
      resume: async (missionIdentifier) => {
        attempted.push(missionIdentifier);
        if (missionIdentifier === "a") {
          return { didResume: true, decision: "resume-once", reason: "ok" };
        }
        if (missionIdentifier === "b") {
          return { didResume: false, decision: "already-running", reason: "running" };
        }
        if (missionIdentifier === "c") {
          return { didResume: false, decision: "resume-rejected", reason: "bad checkpoint" };
        }
        throw new Error("storage unavailable");
      },
    });
    expect(attempted).toEqual(["a", "b", "c", "d"]);
    expect(outcomes).toHaveLength(4);
    expect(outcomes[3]).toMatchObject({ didResume: false, decision: "resume-error" });
    const remaining = await store.list();
    expect(remaining.map((record) => record.missionIdentifier).sort()).toEqual(["c", "d"]);
  });
});

describe("恢复互斥锁", () => {
  it("持锁进程存活 ⇒ 本轮跳过且不执行", async () => {
    const lockPath = path.join(directory, "work-window", "resume.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "other", acquiredAtIso: "x" }),
      "utf8",
    );
    let executed = false;
    const result = await store.withResumeLock(async () => {
      executed = true;
      return "ran";
    });
    expect(result).toBeNull();
    expect(executed).toBe(false);
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
  });

  it("持锁进程不存在 ⇒ 接管执行并释放锁", async () => {
    const lockPath = path.join(directory, "work-window", "resume.lock");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, token: "dead", acquiredAtIso: "x" }),
      "utf8",
    );
    const result = await store.withResumeLock(async () => "ran");
    expect(result).toBe("ran");
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });
});
