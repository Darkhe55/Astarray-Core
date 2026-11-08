/**
 * ALIGN-02-05（2026-11-08）：**跨进程序列领取**闭环。
 *
 * 上一轮只验证了租约本身跨进程可见。真正要问的是：
 * "进程 B 接管租约后，能不能 claim 同一序列任务；A 领过的任务会不会被重复派发？"
 * 这里让两个独立进程共享同一份磁盘序列，直接观察。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import {
  TaskSequenceManageController,
  TaskSequenceStatusController,
} from "../../../packages/core/src/orchestration/task-sequence-controllers.js";

/** RELIABILITY-01：本文件真的起子进程 ⇒ 必须显式给出超时预算。 */
vi.setConfig({ testTimeout: 60_000 });

const fixturePath = fileURLToPath(
  new URL("../../fixtures/sequence-claim-child-fixture.mjs", import.meta.url),
);

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 6 });
    }
  }
});

const owner = "secondary-agent-cross";
const taskId = "task-cross";
const sequenceId = `sequence-${owner}`;
const viewer = { sourceKind: "user" as const, actorId: "user-1" };

function runChild(
  stateDirectory: string,
  action: "claim" | "release" | "status",
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fixturePath, stateDirectory, owner, taskId, action, "process-child"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let stdoutText = "";
    let stderrText = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString("utf8");
      if (stdoutText.includes("\n")) {
        try {
          resolve(JSON.parse(stdoutText.trim()) as Record<string, unknown>);
        } catch {
          /** 等完整 JSON。 */
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (stdoutText.trim() === "") {
        reject(new Error(`子进程无输出（code ${String(code)}）：${stderrText}`));
      }
    });
  });
}

async function seedSequence(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-xproc-seq-"));
  directories.push(directory);
  const store = new AgentTaskSequenceStore({ baseDirectory: directory });
  const manage = new TaskSequenceManageController(store);
  await manage.publishSequence({
    ownerAgentInstanceId: owner,
    actor: viewer,
    sequenceId,
    firstTask: {
      taskId,
      title: "跨进程任务",
      priorityTier: 0,
      externalReference: null,
    },
  });
  return directory;
}

async function statusInParent(stateDirectory: string): Promise<{ status?: string; revision?: number }> {
  const store = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
  const status = new TaskSequenceStatusController(store);
  const snapshot = await status.getSnapshot({
    ownerAgentInstanceId: owner,
    sequenceId,
    viewer,
  });
  return {
    status: snapshot.nodes.find((node) => node.taskId === taskId)?.status,
    revision: snapshot.revision,
  };
}

describe("跨进程序列领取（ALIGN-02-05）", () => {
  it("子进程领取成功 ⇒ 父进程看到 running，且父进程再领失败（不重复派发）", async () => {
    const stateDirectory = await seedSequence();
    const childClaim = await runChild(stateDirectory, "claim");
    expect(childClaim.claimed).toBe(true);
    expect((await statusInParent(stateDirectory)).status).toBe("running");

    const parentStore = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
    const parentManage = new TaskSequenceManageController(parentStore);
    const parentClaim = await parentManage.claimTask({
      ownerAgentInstanceId: owner,
      sequenceId,
      taskId,
    });
    expect(parentClaim).toBe(false);
  });

  it("子进程崩溃遗留 running ⇒ 父进程释放后可以领取（崩溃接管闭环）", async () => {
    const stateDirectory = await seedSequence();
    /** 子进程领取后退出（模拟"领完就崩"）。 */
    const childClaim = await runChild(stateDirectory, "claim");
    expect(childClaim.claimed).toBe(true);
    expect((await statusInParent(stateDirectory)).status).toBe("running");

    const parentStore = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
    const parentManage = new TaskSequenceManageController(parentStore);
    /** 恢复路径的核对动作：释放遗留领取。 */
    expect(
      await parentManage.releaseClaim({
        ownerAgentInstanceId: owner,
        sequenceId,
        taskId,
      }),
    ).toBe(true);
    expect((await statusInParent(stateDirectory)).status).toBe("pending");

    /** 被接管的进程现在能真正领取。 */
    expect(
      await parentManage.claimTask({
        ownerAgentInstanceId: owner,
        sequenceId,
        taskId,
      }),
    ).toBe(true);
    expect((await statusInParent(stateDirectory)).status).toBe("running");
  });

  it("子进程看到父进程改的状态（磁盘共享，不是各自内存）", async () => {
    const stateDirectory = await seedSequence();
    const parentStore = new AgentTaskSequenceStore({ baseDirectory: stateDirectory });
    const parentManage = new TaskSequenceManageController(parentStore);
    expect(
      await parentManage.claimTask({ ownerAgentInstanceId: owner, sequenceId, taskId }),
    ).toBe(true);

    const childStatus = await runChild(stateDirectory, "status");
    expect(childStatus.status).toBe("running");
    /** 子进程再领：同样领不到。 */
    const childClaim = await runChild(stateDirectory, "claim");
    expect(childClaim.claimed).toBe(false);

    /** 子进程释放父进程的领取 ⇒ 双方都回到 pending。 */
    const childRelease = await runChild(stateDirectory, "release");
    expect(childRelease.released).toBe(true);
    expect((await statusInParent(stateDirectory)).status).toBe("pending");
  });
});
