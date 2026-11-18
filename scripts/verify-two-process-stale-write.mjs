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
    if (message.command === "read-verdict") {
      const result = await entry.readVerdictSummary(message);
      reply({ requestId: message.requestId, result });
      return;
    }
    if (message.command === "save-verdict") {
      const result = await entry.saveVerdictIfAbsent(message);
      reply({ requestId: message.requestId, result });
      return;
    }
    if (message.command === "read-receipt") {
      const result = await entry.readReceiptSummary(message);
      reply({ requestId: message.requestId, result });
      return;
    }
    if (message.command === "save-receipt") {
      const result = await entry.saveReceiptIfAbsent(message);
      reply({ requestId: message.requestId, result });
      return;
    }
    if (message.command === "seed-goal") {
      const result = await entry.seedGoalState(message);
      reply({ requestId: message.requestId, result });
      return;
    }
    if (message.command === "read-goal") {
      const result = await entry.readGoalStateRevision(message);
      reply({ requestId: message.requestId, result });
      return;
    }
    if (message.command === "commit-goal") {
      const result = await entry.submitGoalStateCas(message);
      reply({ requestId: message.requestId, result });
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

    /** 5) 同一 harness 复用到 §36.2 的权威存储：目标模式状态。 */
    const goalSeed = await workerA.request("seed-goal", {
      stateDirectory,
      goalIdentifier: "goal-1",
      documentRevision: 1,
      pauseReason: "初始",
    });
    if (goalSeed?.error !== undefined || goalSeed.result.written !== true) {
      throw new Error(`目标状态预置失败：${String(goalSeed?.error ?? "未写入")}`);
    }

    /** A 先读：拿到 documentRevision 1。 */
    const goalReadByA = await workerA.request("read-goal", {
      stateDirectory,
      goalIdentifier: "goal-1",
    });
    if (goalReadByA.result.documentRevision !== 1) {
      throw new Error(`期望读到 documentRevision 1，实际 ${String(goalReadByA.result.documentRevision)}`);
    }

    /** B 提交 1 → 2（最终裁决）。 */
    const goalCommitByB = await workerB.request("commit-goal", {
      stateDirectory,
      goalIdentifier: "goal-1",
      expectedDocumentRevision: 1,
      pauseReason: "B 的裁决",
    });
    if (goalCommitByB.result.outcome !== "written") {
      throw new Error(`B 的目标状态提交应成功，实际 ${goalCommitByB.result.outcome}`);
    }

    /** A 用旧的 1 提交：必须冲突。 */
    const goalStaleByA = await workerA.request("commit-goal", {
      stateDirectory,
      goalIdentifier: "goal-1",
      expectedDocumentRevision: 1,
      pauseReason: "A 的旧状态",
    });
    if (goalStaleByA.result.outcome !== "conflict") {
      throw new Error(`目标状态的陈旧写入未被拒绝：${goalStaleByA.result.outcome}`);
    }

    /** 磁盘仍是 B 的裁决。 */
    const goalFinal = await workerA.request("read-goal", {
      stateDirectory,
      goalIdentifier: "goal-1",
    });
    if (goalFinal.result.documentRevision !== 2 || goalFinal.result.pauseReason !== "B 的裁决") {
      throw new Error(
        `目标状态应为 revision 2 / B 的裁决，实际 ${String(goalFinal.result.documentRevision)} / ${String(
          goalFinal.result.pauseReason,
        )}`,
      );
    }

    console.log("two-process-goal-state-ok: A(旧 revision 1) 冲突，B 的 revision 2 保持");

    /** 6) 完成收据：不可变首次创建（另一个写入者必须被拒，不得静默覆盖）。 */
    const receiptReadByA = await workerA.request("read-receipt", {
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
    });
    if (receiptReadByA.result.toolCallCount !== null) {
      throw new Error("完成收据应尚不存在");
    }

    const receiptByB = await workerB.request("save-receipt", {
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
      toolCallCount: 2,
      artifactPath: "out/b.md",
    });
    if (receiptByB.result.outcome !== "written") {
      throw new Error(`B 的收据应首次写入成功，实际 ${receiptByB.result.outcome}`);
    }

    const receiptByA = await workerA.request("save-receipt", {
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
      toolCallCount: 1,
      artifactPath: "out/a.md",
    });
    if (receiptByA.result.outcome !== "rejected" || receiptByA.result.errorCode !== "journal-corrupted") {
      throw new Error(
        `A 的收据应被拒 journal-corrupted，实际 ${receiptByA.result.outcome} / ${String(receiptByA.result.errorCode)}`,
      );
    }

    const receiptFinal = await workerA.request("read-receipt", {
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
    });
    if (receiptFinal.result.artifactPath !== "out/b.md") {
      throw new Error(`收据应保留 B 的内容，实际 ${String(receiptFinal.result.artifactPath)}`);
    }
    console.log("two-process-receipt-ok: A 的覆盖被拒 journal-corrupted，B 的收据保持");

    /** 7) 独立裁决：同样是不可变首次创建。 */
    const verdictByB = await workerB.request("save-verdict", {
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
      verdict: "accepted",
      deciderAgentInstanceIdentifier: "reviewer-1",
    });
    if (verdictByB.result.outcome !== "written") {
      throw new Error(`B 的裁决应首次写入成功，实际 ${verdictByB.result.outcome}`);
    }

    const verdictByA = await workerA.request("save-verdict", {
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
      verdict: "rejected",
      deciderAgentInstanceIdentifier: "reviewer-2",
    });
    if (verdictByA.result.outcome !== "rejected" || verdictByA.result.errorCode !== "journal-corrupted") {
      throw new Error(
        `A 的裁决应被拒 journal-corrupted，实际 ${verdictByA.result.outcome} / ${String(verdictByA.result.errorCode)}`,
      );
    }

    const verdictFinal = await workerA.request("read-verdict", {
      stateDirectory,
      missionIdentifier: "mission-1",
      taskIdentifier: "T-001",
    });
    if (verdictFinal.result.verdict !== "accepted") {
      throw new Error(`裁决应保留 B 的 accepted，实际 ${String(verdictFinal.result.verdict)}`);
    }
    console.log("two-process-verdict-ok: A 的改写被拒 journal-corrupted，B 的 accepted 保持");
  } finally {
    await Promise.all([workerA.close(), workerB.close()]);
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
