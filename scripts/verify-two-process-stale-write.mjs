#!/usr/bin/env node
/**
 * WIRING-04 §36.4：**两个独立 OS 进程 + IPC 消息控制**的陈旧写入反例。
 *
 * 顺序完全由进程消息驱动（不使用睡眠赌时序）：
 *   1) 父进程 → A：read（A 读到 revision N 并回报）
 *   2) 父进程 → B：commit（B 提交 N+1，成为最终裁决）
 *   3) 父进程 → A：submit-stale（A 用**旧的 N** 提交）
 *   4) 断言：A 被拒（stale-revision），磁盘仍是 B 的裁决，且无重复副作用。
 *
 * 入口由 tsup 现场打包（仓库没有稳定的模块入口），随后两个 node 进程通过 IPC 驱动。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessOutputDirectory = path.join(repositoryRoot, ".tmp", "two-process-harness");
const harnessEntryFileName = "two-process-harness-entry.js";

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules", "tsup", "dist", "cli-default.js"),
        "scripts/two-process-harness-entry.ts",
        "--format",
        "esm",
        "--out-dir",
        harnessOutputDirectory,
        "--clean",
        "--silent",
      ],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
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
      reject(new Error(`tsup 打包失败（退出码 ${String(code)}）：\n${output.slice(-1500)}`));
    });
  });
}

/**
 * 启动一个持久的 node 工作进程（带 IPC 通道），返回 send/close 句柄。
 */
function startWorker(entryPath, workerName) {
  const script = `
import { pathToFileURL } from "node:url";
const entry = await import(pathToFileURL(${JSON.stringify(entryPath)}).href);
process.on("message", async (message) => {
  if (message === null || typeof message !== "object") return;
  const reply = (payload) => process.send({ worker: ${JSON.stringify(workerName)}, ...payload });
  try {
    if (message.command === "read") {
      const state = await entry.readChainRevision(message.stateDirectory);
      reply({ requestId: message.requestId, result: state });
      return;
    }
    if (message.command === "commit") {
      const result = await entry.submitStaleOrFresh({
        stateDirectory: message.stateDirectory,
        expectedRevision: message.expectedRevision,
        status: message.status,
      });
      reply({ requestId: message.requestId, result });
      return;
    }
    reply({ requestId: message.requestId, error: "unknown-command" });
  } catch (error) {
    reply({ requestId: message.requestId, error: String(error?.message ?? error) });
  }
});
process.send({ worker: ${JSON.stringify(workerName)}, ready: true });
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const pending = new Map();
  let nextRequestId = 1;
  let isReady = false;
  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });
  child.on("message", (message) => {
    if (message?.ready === true) {
      isReady = true;
      resolveReady?.(undefined);
      return;
    }
    const requestId = message?.requestId;
    if (typeof requestId === "number" && pending.has(requestId)) {
      const resolve = pending.get(requestId);
      pending.delete(requestId);
      resolve(message);
    }
  });
  child.on("exit", (code) => {
    for (const resolve of pending.values()) {
      resolve({ error: `worker 退出（code ${String(code)}）`, stderr });
    }
    pending.clear();
  });
  return {
    isReadyRef: () => isReady,
    ready: readyPromise,
    request: (command, payload) =>
      new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        pending.set(requestId, resolve);
        child.send({ command, requestId, ...payload }, (error) => {
          if (error !== undefined && error !== null) {
            pending.delete(requestId);
            reject(error);
          }
        });
        setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId);
            reject(new Error(`worker ${workerName} 未在 30s 内回复 ${command}`));
          }
        }, 30_000);
      }),
    close: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve(undefined));
        child.kill();
      }),
    getLogs: () => ({ stdout, stderr }),
  };
}

async function main() {
  await fs.mkdir(harnessOutputDirectory, { recursive: true });
  await runBuild();
  const entryPath = path.join(harnessOutputDirectory, harnessEntryFileName);
  await fs.access(entryPath);

  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "two-process-stale-"));
  const missionDirectory = path.join(stateDirectory, "missions", "mission-1");
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(
    path.join(missionDirectory, "task-chain.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId: "mission-1",
      revision: 3,
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

  const workerA = startWorker(entryPath, "A");
  const workerB = startWorker(entryPath, "B");
  try {
    await Promise.all([workerA.ready, workerB.ready]);

    /** 1) A 先读：拿到 revision 3。 */
    const readReply = await workerA.request("read", { stateDirectory });
    if (readReply?.error !== undefined) {
      throw new Error(`A 读取失败：${readReply.error}`);
    }
    const observedRevision = readReply.result.revision;
    if (observedRevision !== 3) {
      throw new Error(`期望 A 读到 revision 3，实际 ${String(observedRevision)}`);
    }

    /** 2) B 提交：3 → 4（成为最终裁决）。 */
    const commitReply = await workerB.request("commit", {
      stateDirectory,
      expectedRevision: 3,
      status: "done",
    });
    if (commitReply?.error !== undefined) {
      throw new Error(`B 提交失败：${commitReply.error}`);
    }
    if (commitReply.result.outcome !== "accepted") {
      throw new Error(`B 的提交应被接受，实际 ${commitReply.result.outcome}`);
    }

    /** 3) A 用**旧的 3** 提交：必须被拒。 */
    const staleReply = await workerA.request("commit", {
      stateDirectory,
      expectedRevision: 3,
      status: "running",
    });
    if (staleReply?.error !== undefined) {
      throw new Error(`A 提交失败（预期是业务拒绝而不是进程错误）：${staleReply.error}`);
    }
    if (staleReply.result.outcome !== "rejected") {
      throw new Error(`陈旧写入未被拒绝：${staleReply.result.outcome}`);
    }
    if (staleReply.result.errorCode !== "stale-revision") {
      throw new Error(`陈旧写入的拒绝码不是 stale-revision：${String(staleReply.result.errorCode)}`);
    }

    /** 4) 磁盘仍是 B 的裁决。 */
    const finalReply = await workerA.request("read", { stateDirectory });
    if (finalReply.result.revision !== 4 || finalReply.result.status !== "done") {
      throw new Error(
        `最终状态应为 revision 4 / done，实际 ${String(finalReply.result.revision)} / ${String(
          finalReply.result.status,
        )}`,
      );
    }

    console.log(
      "two-process-stale-write-ok: A(旧 revision 3) 被拒 stale-revision，B 的 revision 4/done 保持",
    );
  } finally {
    await Promise.all([workerA.close(), workerB.close()]);
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
