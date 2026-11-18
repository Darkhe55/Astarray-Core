/**
 * 巡检轮（2026-11-18 12:00）：**跨实例旧 revision 覆盖必须被拒绝**。
 *
 * `TaskStore` 的互斥锁只在**单实例**内有效。真实多进程场景下，第二个进程
 * （或重建后的实例）可能拿着旧文档来写。此处的既有保护是"旧 revision 拒绝"，
 * 但此前没有测试钉住它——一旦被删，跨进程会**静默覆盖**别人的写入。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskStore } from "../../../packages/core/src/infra/task-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "task-chain-stale-guard-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): TaskStore {
  return new TaskStore({ baseDirectory: stateDirectory });
}

function buildChain(revision: number, status: "running" | "done"): Parameters<TaskStore["writeTaskChain"]>[0] {
  return {
    schemaVersion: 1,
    missionId: "mission-1",
    revision,
    updatedAtIso: "2026-11-18T00:00:00.000Z",
    tasks: [
      {
        id: "T-001",
        description: "执行",
        dependsOn: [],
        taskType: "data",
        toolNames: [],
        assignedAgentId: null,
        status,
        resultLocation: null,
      },
    ],
  };
}

describe("任务链旧 revision 覆盖保护", () => {
  it("① 第二个实例拿旧 revision 写入 ⇒ 被拒绝（stale-revision）", async () => {
    const firstInstance = buildStore();
    await firstInstance.writeTaskChain(buildChain(1, "running"));
    /** 模拟另一个进程：它读到的仍是 revision 1，随后本进程已推进到 2。 */
    const staleDocument = buildChain(2, "done");
    await firstInstance.writeTaskChain(buildChain(2, "running"));

    const secondInstance = buildStore();
    await expect(secondInstance.writeTaskChain(staleDocument)).rejects.toMatchObject({
      errorCode: "stale-revision",
    });
  }, 60_000);

  it("② 拒绝之后，链上内容仍是胜出的那次写入（未被静默覆盖）", async () => {
    const store = buildStore();
    await store.writeTaskChain(buildChain(1, "running"));
    await store.writeTaskChain(buildChain(2, "running"));

    /** 旧文档（revision 2、status done）试图覆盖 revision 2 ⇒ 拒绝。 */
    await expect(buildStore().writeTaskChain(buildChain(2, "done"))).rejects.toMatchObject({
      errorCode: "stale-revision",
    });

    const reloaded = await buildStore().readTaskChain("mission-1");
    expect(reloaded?.revision).toBe(2);
    expect(reloaded?.tasks[0]?.status).toBe("running");
  }, 60_000);

  it("③ 递增 revision 的正常更新仍然成功（保护不过度拦截）", async () => {
    const store = buildStore();
    await store.writeTaskChain(buildChain(1, "running"));
    await store.writeTaskChain(buildChain(2, "done"));
    const reloaded = await buildStore().readTaskChain("mission-1");
    expect(reloaded?.revision).toBe(2);
    expect(reloaded?.tasks[0]?.status).toBe("done");
  }, 60_000);
});
