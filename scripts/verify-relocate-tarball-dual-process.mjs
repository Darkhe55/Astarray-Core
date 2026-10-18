#!/usr/bin/env node
/**
 * RELOCATE-01-04 / HISTORY-01-04 的**交付门禁**：npm tarball 隔离安装后的双进程证据。
 *
 * 为什么要这个脚本：仓库此前如实记着「tarball 双进程搬迁证据**未取得**」
 * （`docs/reports/TASKCARD_BACKLOG_2026-10-17.md` §13.2，理由是"本机 npm install 不生成
 * node_modules"）。而 `verify-sdk-consumer.mjs` 早就在做隔离安装 ⇒ 该理由经不起复核。
 * 本脚本把"能否用**已安装的公开包**做跨进程搬迁与历史回溯"变成**可复跑**的判据：
 *
 * 1. 在临时目录 `npm install <tarball> --ignore-scripts`（不碰仓库、不联网装额外东西）；
 * 2. **进程 A**（`processA.mjs`）用已安装包的**公开出口** `astarray/public-sdk.js`：
 *    - 写项目位置登记（`project-alpha` → 当前根）；
 *    - 写运行历史（工具调用 + 失败调用 + 过程说明）；
 * 3. **进程 B**（另一个 node 进程）用已安装包的 **CLI**（`node_modules/astarray/dist/cli.js`）：
 *    - `project status --project project-alpha --root <root> --observed-identifier project-alpha --json`
 *      ⇒ 必须 `identity-confirmed` / `isHistoryLoadable:true` / `isExecutionAllowed:false`；
 *    - `history list --json` ⇒ 能看到进程 A 写的 mission；
 *    - `history show --mission <id> --json` ⇒ 能看到工具调用与**失败原因**；
 *    - `history show` 的文本输出不得含 ANSI/控制序列。
 * 4. **只读纪律**：搬迁查询后项目根目录必须**仍为空**（不得自动新建目录）；
 *    历史查看不得产生新的运行历史文件。
 *
 * 用法：node scripts/verify-relocate-tarball-dual-process.mjs <tarball-path>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tarballPath = process.argv[2];
if (tarballPath === undefined || !existsSync(tarballPath)) {
  console.error("用法: node scripts/verify-relocate-tarball-dual-process.mjs <tarball-path>");
  process.exit(1);
}

const workspace = mkdtempSync(path.join(os.tmpdir(), "astarray-relocate-tarball-"));
const projectRootPath = path.join(workspace, "project-root");

/** 进程 A 的脚本：只用**公开出口**写登记与运行历史。 */
const processASource = `
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { RunHistoryStore, ProjectLocationRegistrationStore } from "astarray";

const stateDirectory = process.argv[2];
const projectRootPath = process.argv[3];

const registrationStore = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
await registrationStore.writeWithBackup({
  schemaVersion: 1,
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-" + randomUUID(),
  rootPath: projectRootPath,
  previousRootPath: null,
  locationRevision: 2,
  confirmedBy: "user",
  confirmedAtIso: new Date("2026-10-18T00:00:00.000Z").toISOString(),
});

const runHistoryStore = new RunHistoryStore({ baseDirectory: stateDirectory });
await runHistoryStore.recordToolCall({
  missionIdentifier: "mission-tarball",
  toolName: "readFile",
  outputText: "file-content-from-process-a",
  recordedAtIso: "2026-10-18T00:00:01.000Z",
});
await runHistoryStore.recordToolFailure({
  missionIdentifier: "mission-tarball",
  toolName: "writeFile",
  failureReason: "permission-denied",
  recordedAtIso: "2026-10-18T00:00:02.000Z",
});
await runHistoryStore.appendEvent({
  missionIdentifier: "mission-tarball",
  event: {
    eventIdentifier: "note-from-process-a",
    kind: "model-note",
    recordedAtIso: "2026-10-18T00:00:03.000Z",
    payloadJson: JSON.stringify({ note: "先读后写" }),
  },
});

const historyFilePath = path.join(stateDirectory, "run-history", "mission-tarball.json");
const historyDocument = await runHistoryStore.read("mission-tarball");
console.log(JSON.stringify({
  processIdentifier: process.pid,
  wroteRegistration: true,
  historyReadKind: historyDocument.kind,
  historyFilePath,
}));
`;

/** 进程 B 的辅助：在**独立进程**里跑，不复用进程 A 的任何内存状态。 */
function runCli(args) {
  return spawnSync(process.execPath, [path.join(workspace, "node_modules/astarray/dist/cli.js"), ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function parseJsonObjectFromOutput(text) {
  const startIndex = text.indexOf("{");
  if (startIndex === -1) return null;
  try {
    return JSON.parse(text.slice(startIndex));
  } catch {
    return null;
  }
}

const failures = [];
const evidence = {};

try {
  // 状态目录就是 CLI 默认的 `<cwd>/.astarray`
  mkdirSync(projectRootPath, { recursive: true });
  const stateDirectory = path.join(workspace, ".astarray");

  const install = spawnSync(
    "npm",
    [
      "install",
      path.resolve(tarballPath),
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--prefer-offline",
    ],
    { cwd: workspace, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (install.status !== 0) {
    console.error("❌ 隔离安装失败（npm install <tarball>）");
    process.exit(1);
  }

  // ── 进程 A ────────────────────────────────────────────────────────────────
  writeFileSync(path.join(workspace, "processA.mjs"), processASource, "utf8");
  const processA = spawnSync(process.execPath, ["processA.mjs", stateDirectory, projectRootPath], {
    cwd: workspace,
    encoding: "utf8",
  });
  process.stderr.write(processA.stderr ?? "");
  const processAReport = parseJsonObjectFromOutput(processA.stdout ?? "");
  if (processA.status !== 0 || processAReport === null) {
    console.error("❌ 进程 A（写入方）失败：" + (processA.stderr ?? "").slice(0, 400));
    process.exit(1);
  }
  evidence.processA = {
    processIdentifier: processAReport.processIdentifier,
    historyReadKind: processAReport.historyReadKind,
  };
  if (processAReport.historyReadKind !== "valid") {
    failures.push("进程 A 写入后读回不是 valid");
  }

  // ── 进程 B：搬迁状态 ──────────────────────────────────────────────────────
  const projectStatus = runCli([
    "project",
    "status",
    "--project",
    "project-alpha",
    "--root",
    projectRootPath,
    "--observed-identifier",
    "project-alpha",
    "--json",
  ]);
  const projectStatusPayload = parseJsonObjectFromOutput(projectStatus.stdout ?? "");
  if (projectStatus.status !== 0 || projectStatusPayload === null) {
    failures.push("project status 未成功（exit=" + String(projectStatus.status) + "）");
  } else {
    const payload = projectStatusPayload;
    evidence.projectStatus = {
      classification: payload.classification,
      isHistoryLoadable: payload.isHistoryLoadable,
      isExecutionAllowed: payload.isExecutionAllowed,
      requiredUserAction: payload.requiredUserAction,
    };
    if (payload.classification !== "identity-confirmed") {
      failures.push("搬迁分类应为 identity-confirmed，实得 " + String(payload.classification));
    }
    if (payload.isHistoryLoadable !== true) failures.push("应可加载历史（isHistoryLoadable=true）");
    if (payload.isExecutionAllowed !== false) {
      failures.push("只读查询不得授权执行（isExecutionAllowed 必须为 false）");
    }
  }

  // 只读纪律：搬迁查询不得在项目根下新建任何目录/文件
  const projectRootEntries = readdirSync(projectRootPath);
  evidence.projectRootEntryCountAfterQuery = projectRootEntries.length;
  if (projectRootEntries.length !== 0) {
    failures.push("查询搬迁状态后在项目根新建了条目：" + projectRootEntries.join(", "));
  }

  // ── 进程 B：历史回溯 ──────────────────────────────────────────────────────
  const historyList = runCli(["history", "list", "--json"]);
  const historyListPayload = parseJsonObjectFromOutput(historyList.stdout ?? "");
  if (historyList.status !== 0 || historyListPayload === null) {
    failures.push("history list 未成功（exit=" + String(historyList.status) + "）");
  } else {
    const missions = (historyListPayload.entries ?? []).map(
      (entry) => entry.missionIdentifier,
    );
    evidence.historyListMissions = missions;
    if (!missions.includes("mission-tarball")) {
      failures.push("history list 未列出进程 A 写入的 mission");
    }
  }

  const historyShow = runCli(["history", "show", "--mission", "mission-tarball", "--json"]);
  const historyShowPayload = parseJsonObjectFromOutput(historyShow.stdout ?? "");
  if (historyShow.status !== 0 || historyShowPayload === null) {
    failures.push("history show 未成功（exit=" + String(historyShow.status) + "）");
  } else {
    const payload = historyShowPayload;
    const kinds = (payload.entries ?? []).map((entry) => entry.kind);
    const detailTexts = (payload.entries ?? []).map((entry) => entry.detailText).join("\n");
    evidence.historyShow = {
      kinds,
      storedEventCount: payload.storedEventCount,
      notice: payload.notice,
    };
    if (!kinds.includes("tool-call")) failures.push("history show 未显示工具调用");
    if (!kinds.includes("tool-failure")) failures.push("history show 未显示失败调用");
    if (!detailTexts.includes("permission-denied")) failures.push("失败原因未保留在历史里");
    if (payload.storedEventCount !== 3) {
      failures.push("事件总数应为 3，实得 " + String(payload.storedEventCount));
    }
  }

  const historyText = runCli(["history", "show", "--mission", "mission-tarball"]);
  if (historyText.status !== 0) failures.push("history show 文本模式未成功");
  if ((historyText.stdout ?? "").includes("\u001B")) {
    failures.push("文本输出含 ANSI 控制序列");
  }

  // 查看历史不得新增运行历史文件（不得触发重放/新写入）
  const runHistoryDirectory = path.join(stateDirectory, "run-history");
  const historyFileCount = readdirSync(runHistoryDirectory).filter((name) =>
    name.endsWith(".json"),
  ).length;
  evidence.runHistoryFileCountAfterViews = historyFileCount;
  if (historyFileCount !== 1) {
    failures.push("查看历史后运行历史文件数变化（应为 1，实得 " + String(historyFileCount) + "）");
  }

  evidence.workspace = workspace;
  evidence.tarballPath = path.resolve(tarballPath);

  if (failures.length > 0) {
    console.error("❌ tarball 双进程证据未通过：\n  - " + failures.join("\n  - "));
    console.error(JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  } else {
    console.log("tarball 双进程搬迁与历史回溯验证通过: " + JSON.stringify(evidence));
  }
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
