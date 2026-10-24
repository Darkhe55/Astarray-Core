#!/usr/bin/env node
/**
 * EVENT-01 安装包状态入口验收（2026-10-24）。
 *
 * 用法：node scripts/verify-event01-package.mjs --package-dir <已安装包目录>
 *
 * 判据：
 * 1. `astarray event status --json` 在**无日志**时退出码 0，且明确写「空 ≠ 无事件」（不伪造事故）；
 * 2. 写入一份合法日志后，能读到事故（kind/severity/state），并写明「只读」；
 * 3. 损坏日志 ⇒ 退出码 2 并说明不可读（不静默当空）；
 * 4. 状态查询**只读**：运行前后日志文件字节一致。
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArguments(argv) {
  const options = { packageDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") {
      options.packageDirectory =
        argv[index + 1] === undefined ? null : path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.packageDirectory === null) {
  process.stderr.write("用法：node scripts/verify-event01-package.mjs --package-dir <package>\n");
  process.exit(2);
}

const cliPath = path.join(options.packageDirectory, "dist", "cli.js");
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-event01-pkg-"));
const journalPath = path.join(stateDirectory, ".astarray", "events", "incidents.json");
const failures = [];
const observations = {};

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: stateDirectory,
    encoding: "utf8",
  });
}

try {
  const absentRun = runCli(["event", "status", "--json"]);
  observations.absentExitCode = absentRun.status ?? -1;
  if (absentRun.status !== 0) failures.push("无日志时 event status 退出码应为 0，实际 " + String(absentRun.status));
  try {
    const payload = JSON.parse(absentRun.stdout);
    observations.absentPresent = payload.isPresent;
    if (payload.isPresent !== false) failures.push("无日志时 isPresent 必须为 false");
    if (typeof payload.notice !== "string" || !payload.notice.includes("空 ≠ 无事件")) {
      failures.push("无日志时必须写「空 ≠ 无事件」，实际 " + String(payload.notice));
    }
  } catch (error) {
    failures.push("无日志输出不是合法 JSON：" + String(error));
  }

  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  await fs.writeFile(
    journalPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        revision: 1,
        updatedAtIso: "2026-10-24T00:00:00.000Z",
        snapshot: {
          schemaVersion: 1,
          toolCapabilities: [{ toolName: "readFile", supportsCancellation: true }],
          incidents: [
            {
              incidentIdentifier: "incident-0001",
              kind: "process-exit",
              resourceKey: "runtime-1",
              severity: "critical",
              epoch: 3,
              receivedAtIso: "2026-10-24T00:00:00.000Z",
              deadlineAtIso: "2026-10-24T00:01:00.000Z",
              state: "received",
              ownerAgentInstanceId: null,
              mergedEventCount: 0,
              wasReceivedWhileSaturated: false,
              degradationReason: null,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const before = await fs.readFile(journalPath, "utf8");

  const presentRun = runCli(["event", "status", "--json"]);
  observations.presentExitCode = presentRun.status ?? -1;
  if (presentRun.status !== 0) failures.push("有日志时 event status 退出码应为 0，实际 " + String(presentRun.status));
  try {
    const payload = JSON.parse(presentRun.stdout);
    if (payload.isPresent !== true) failures.push("有日志时 isPresent 必须为 true");
    if (!Array.isArray(payload.incidents) || payload.incidents.length !== 1) {
      failures.push("有日志时必须读到 1 条事故，实际 " + String(payload.incidents?.length));
    }
    if (payload.incidents?.[0]?.severity !== "critical") {
      failures.push("事故 severity 必须如实透出（critical）");
    }
    if (typeof payload.notice !== "string" || !payload.notice.includes("只读")) {
      failures.push("必须写明只读");
    }
  } catch (error) {
    failures.push("有日志输出不是合法 JSON：" + String(error));
  }

  const after = await fs.readFile(journalPath, "utf8");
  if (before !== after) failures.push("event status 必须是只读：日志字节被改动");

  await fs.writeFile(journalPath, "{broken", "utf8");
  const brokenRun = runCli(["event", "status", "--json"]);
  observations.brokenExitCode = brokenRun.status ?? -1;
  if (brokenRun.status !== 2) failures.push("损坏日志时退出码必须为 2，实际 " + String(brokenRun.status));
  if (!String(brokenRun.stderr).includes("不可读")) failures.push("损坏日志必须说明不可读（不静默当空）");

  process.stdout.write(
    `${JSON.stringify(
      {
        packageDirectory: options.packageDirectory,
        stateDirectory,
        observations,
        failures,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`EVENT-01 安装包状态入口验收失败：${String(failures.length)} 项\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}
process.stdout.write("EVENT-01 安装包状态入口通过：空≠无事件、只读、损坏退出码 2\n");
