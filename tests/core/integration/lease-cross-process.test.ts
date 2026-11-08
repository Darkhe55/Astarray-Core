/**
 * ALIGN-02-05（2026-11-08）：**跨进程**租约隔离端到端。
 *
 * 之前所有证据都在单进程内模拟"进程 A 已死"。这里真的起两个独立进程：
 * 子进程持有租约（模拟崩溃前后两种状态），父进程在自己的 store 上尝试申请/接管。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { vi } from "vitest";

import { MissionLeaseStore } from "../../../packages/core/src/infra/mission-lease-store.js";

/** RELIABILITY-01：本文件真的起子进程 ⇒ 必须显式给出超时预算。 */
vi.setConfig({ testTimeout: 60_000 });

const fixturePath = fileURLToPath(
  new URL("../../fixtures/mission-lease-child-fixture.mjs", import.meta.url),
);

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 6 });
    }
  }
});

/** 起子进程做一次租约动作，返回它打印的 JSON。 */
function runChild(
  stateDirectory: string,
  action: "acquire" | "hold",
  processInstanceId: string,
  options: { keepAlive?: boolean; leaseTtlMilliseconds?: number } = {},
): Promise<{ status?: string; pid?: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fixturePath, stateDirectory, action, processInstanceId],
      {
        stdio: ["ignore", "pipe", "pipe"],
        ...(options.leaseTtlMilliseconds === undefined
          ? {}
          : {
              env: {
                ...process.env,
                ASTARRAY_FIXTURE_LEASE_TTL_MILLISECONDS: String(
                  options.leaseTtlMilliseconds,
                ),
              },
            }),
      },
    );
    if (options.keepAlive === true) children.push(child);
    let stdoutText = "";
    let stderrText = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutText += text;
      if (text.includes("\n")) {
        try {
          resolve(JSON.parse(stdoutText.trim()));
        } catch {
          /** 继续等完整 JSON。 */
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

async function createStateDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("跨进程租约隔离（ALIGN-02-05）", () => {
  it("子进程已持有租约 ⇒ 父进程申请被拒（locked-active，属主不被覆盖）", async () => {
    const stateDirectory = await createStateDirectory("astarray-xproc-hold-");
    const childResult = await runChild(
      stateDirectory,
      "hold",
      "process-child",
      { keepAlive: true },
    );
    expect(childResult.status).toBe("acquired");

    const parentStore = new MissionLeaseStore({ stateDirectory });
    const parentClaim = await parentStore.tryAcquire({
      missionId: "mission-x",
      processInstanceId: "process-parent",
      purpose: "run",
      claimantDescription: "parent",
    });
    expect(parentClaim.status).toBe("locked-active");
    const lease = await parentStore.readLease("mission-x");
    expect(lease?.processInstanceId).toBe("process-child");
  });

  it("子进程被杀（崩溃）后租约过期 ⇒ 父进程可接管并换属主", async () => {
    const stateDirectory = await createStateDirectory("astarray-xproc-crash-");
    const childResult = await runChild(
      stateDirectory,
      "hold",
      "process-child",
      { keepAlive: true, leaseTtlMilliseconds: 300 },
    );
    expect(childResult.status).toBe("acquired");

    /** 杀掉子进程 = 进程 A 崩溃（租约文件留在磁盘上）。 */
    for (const child of children.splice(0)) child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));

    const parentStore = new MissionLeaseStore({
      stateDirectory,
      /** 短 TTL：让"崩溃后过期"在测试内可发生，不依赖真实 30s。 */
      leaseTtlMilliseconds: 300,
    });
    /** 等子进程写入的短 TTL 过期（它已死，不会续约）。 */
    await new Promise((resolve) => setTimeout(resolve, 400));
    const summaryAfterExpiry = await parentStore.readLeaseSummary(
      "mission-x",
      "process-parent",
    );
    expect(summaryAfterExpiry.exists).toBe(true);
    expect(summaryAfterExpiry.isActive).toBe(false);

    /** 过期后可接管：属主换成父进程，revision 前进。 */
    const takenOver = await parentStore.takeOverExpiredLease("mission-x", 1, {
      missionId: "mission-x",
      processInstanceId: "process-parent",
      purpose: "run",
      claimantDescription: "parent",
    });
    expect(takenOver.processInstanceId).toBe("process-parent");
    expect(takenOver.leaseRevision).toBe(2);
  });

  it("子进程写入的租约对父进程可见（同一份磁盘状态，不是内存假象）", async () => {
    const stateDirectory = await createStateDirectory("astarray-xproc-acquire-");
    const childResult = await runChild(
      stateDirectory,
      "acquire",
      "process-child",
    );
    expect(childResult.status).toBe("acquired");

    const parentStore = new MissionLeaseStore({ stateDirectory });
    const lease = await parentStore.readLease("mission-x");
    expect(lease?.processInstanceId).toBe("process-child");
    expect(lease?.leaseRevision).toBe(1);
    /** 父进程申请：子进程已退出但租约未过期 ⇒ 仍然拒绝（不误派发）。 */
    const parentClaim = await parentStore.tryAcquire({
      missionId: "mission-x",
      processInstanceId: "process-parent",
      purpose: "run",
      claimantDescription: "parent",
    });
    expect(["locked-active", "locked-stale"]).toContain(parentClaim.status);
  });
});

