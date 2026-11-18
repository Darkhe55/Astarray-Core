#!/usr/bin/env node
/**
 * 真实双进程文件锁验证（2026-11-18）。
 *
 * 集成测试用"两个实例"模拟两个进程；本脚本起 **两个独立的 vitest 进程**，
 * 各自对同一任务链做 20 次读-改-写，父进程断言最终 revision 恰为 41。
 *
 * 用法：node scripts/verify-cross-process-file-lock.mjs
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntryPath = path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const workerTestPath = "tests/support/cross-process-lock-worker.test.ts";

function runWorkerProcess(stateDirectory, workerIdentifier) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitestEntryPath, "run", workerTestPath, "--maxWorkers=1", "--silent"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, CROSS_PROCESS_LOCK_STATE_DIR: stateDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(
        new Error(`worker ${workerIdentifier} 失败（退出码 ${String(code)}）：\n${output.slice(-2000)}`),
      );
    });
  });
}

async function main() {
  await fs.access(vitestEntryPath).catch(() => {
    throw new Error("找不到 vitest 入口；请先在仓库根目录安装依赖");
  });

  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cross-process-lock-"));
  try {
    /** 预置任务链（只写状态目录，不触碰项目源码）。 */
    const missionDirectory = path.join(stateDirectory, "missions", "mission-1");
    await fs.mkdir(missionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(missionDirectory, "task-chain.json"),
      JSON.stringify({
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
      }),
      "utf8",
    );

    await Promise.all([
      runWorkerProcess(stateDirectory, "worker-a"),
      runWorkerProcess(stateDirectory, "worker-b"),
    ]);

    const chain = JSON.parse(
      await fs.readFile(path.join(missionDirectory, "task-chain.json"), "utf8"),
    );
    if (chain.revision !== 41) {
      throw new Error(`期望 revision=41，实际 ${String(chain.revision)}（跨进程更新丢失）`);
    }
    console.log("cross-process-file-lock-ok: 两个真实进程并发更新后 revision=41");
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
