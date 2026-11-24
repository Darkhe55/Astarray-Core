/**
 * 内部用户测试走查脚本（2026-11-24）。
 *
 * 覆盖《内部用户测试就绪度与完整使用说明》§5 的 1–12 步（脚本内不跑 `npm run check`，
 * 那一步由 CI/人工单独执行，避免本脚本变成递归门禁）。全部使用**临时数据目录**，
 * 结束即清理；不联网、不写仓库目录。
 *
 * 退出码：0 = 全部符合期望；1 = 至少一步不符合；2 = 前置条件缺失（未构建 dist）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = process.cwd();
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");
const dataDirectory = mkdtempSync(path.join(tmpdir(), "astarray-walkthrough-"));
const stateDirectory = path.join(dataDirectory, "state");
mkdirSync(stateDirectory, { recursive: true });

const environment = {
  ...process.env,
  ASTARRAY_DATA_DIR: dataDirectory,
  ASTARRAY_HOST_USER: process.env.ASTARRAY_HOST_USER ?? "walkthrough-user",
  NO_COLOR: "1",
};

const results = [];

function runCli(argumentsList, options = {}) {
  const result = spawnSync(process.execPath, [cliEntryPath, ...argumentsList], {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    timeout: options.timeoutMilliseconds ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function record(name, isPassed, detail) {
  results.push({ name, isPassed, detail });
  const marker = isPassed ? "PASS" : "FAIL";
  console.log(`[${marker}] ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

function isJsonParseable(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!isJsonParseable("{}") || !cliEntryPath.endsWith("cli.js")) {
    record("前置条件：dist/cli.js 存在", false, cliEntryPath);
    return 2;
  }

  // 1. 帮助可用
  const help = runCli(["--help"]);
  record("1. --help 可用", help.status === 0 && help.stdout.includes("astarray"), `exit=${String(help.status)}`);

  // 2. doctor
  const doctor = runCli(["doctor", "--json"]);
  record(
    "2. doctor --json",
    doctor.status === 0 && isJsonParseable(doctor.stdout),
    `exit=${String(doctor.status)}`,
  );

  // 3. mock 运行
  const run = runCli(["run", "验证本地任务流程", "--mode", "assist", "--runtime", "mock", "--json"]);
  let missionIdentifier = null;
  if (run.status === 0 && isJsonParseable(run.stdout)) {
    const parsed = JSON.parse(run.stdout);
    missionIdentifier =
      typeof parsed.missionId === "string"
        ? parsed.missionId
        : typeof parsed.missionIdentifier === "string"
          ? parsed.missionIdentifier
          : null;
  }
  record("3. run mock 返回 mission", run.status === 0 && missionIdentifier !== null, `exit=${String(run.status)}`);

  if (missionIdentifier === null) {
    record("4. status 单 mission", false, "前置步骤未产生 missionId");
    record("5. resume 已完成早返回", false, "前置步骤未产生 missionId");
    record("6. history show", false, "前置步骤未产生 missionId");
  } else {
    // 4. status
    const status = runCli(["status", missionIdentifier, "--json"]);
    let statusValue = null;
    if (status.status === 0 && isJsonParseable(status.stdout)) {
      statusValue = JSON.parse(status.stdout).status ?? null;
    }
    record("4. status 单 mission 为 done", status.status === 0 && statusValue === "done", `status=${String(statusValue)}`);

    // 5. resume 已完成
    const resume = runCli(["resume", missionIdentifier]);
    record("5. resume 已完成早返回", resume.status === 0 && resume.stdout.includes("already-complete"), `exit=${String(resume.status)}`);

    // 6. history
    const history = runCli(["history", "show", "--mission", missionIdentifier, "--json"]);
    record("6. history show --json", history.status === 0 && isJsonParseable(history.stdout), `exit=${String(history.status)}`);
  }

  // 7. recover list
  const recoverList = runCli(["recover", "list", "--json"]);
  record(
    "7. recover list --json",
    recoverList.status === 0 && isJsonParseable(recoverList.stdout),
    `exit=${String(recoverList.status)}`,
  );

  // 8. goal-mode status（只读）
  const goalStatus = runCli(["goal-mode", "status", "--json"]);
  record(
    "8. goal-mode status --json",
    goalStatus.status === 0 && isJsonParseable(goalStatus.stdout),
    `exit=${String(goalStatus.status)}`,
  );

  // 9. continuation breakpoints（空会话）
  const breakpoints = runCli(["continuation", "breakpoints", "--conversation", "walkthrough", "--json"]);
  record(
    "9. continuation breakpoints 空会话",
    breakpoints.status === 0 && breakpoints.stdout.trim() === "[]",
    `exit=${String(breakpoints.status)}`,
  );

  // 10. profile list
  const profileList = runCli(["profile", "list", "--json"]);
  let builtinCount = 0;
  if (profileList.status === 0 && isJsonParseable(profileList.stdout)) {
    builtinCount = Array.isArray(JSON.parse(profileList.stdout).profiles)
      ? JSON.parse(profileList.stdout).profiles.length
      : 0;
  }
  record("10. profile list 含三个内置组", profileList.status === 0 && builtinCount >= 3, `count=${String(builtinCount)}`);

  // 11. task-ledger 只读
  const ledger = runCli(["task-ledger", "status", "--list-bindings", "--json"]);
  let bindingStatus = null;
  if (ledger.status === 0 && isJsonParseable(ledger.stdout)) {
    bindingStatus = JSON.parse(ledger.stdout).status ?? null;
  }
  /** 走查先跑过 mock 任务，索引可能已登记 ⇒ 两种诚实状态都接受。 */
  const isBindingStatusHonest =
    bindingStatus === "no-bindings" || bindingStatus === "listed";
  record(
    "11. task-ledger list-bindings",
    ledger.status === 0 && isBindingStatusHonest,
    `status=${String(bindingStatus)}`,
  );

  // 12. gui 必须 fail-closed
  const gui = runCli(["gui"]);
  const guiText = `${gui.stdout}\n${gui.stderr}`;
  record("12. gui fail-closed", gui.status !== 0 && guiText.includes("不含 Web GUI"), `exit=${String(gui.status)}`);

  const failed = results.filter((entry) => !entry.isPassed);
  console.log(
    `\n走查结果：${String(results.length - failed.length)}/${String(results.length)} 通过；临时数据目录 ${dataDirectory}`,
  );
  if (failed.length > 0) {
    console.log("未通过项：");
    for (const entry of failed) {
      console.log(`  - ${entry.name}（${entry.detail ?? "无详情"}）`);
    }
    return 1;
  }
  return 0;
}

let exitCode;
try {
  exitCode = main();
} finally {
  if (process.env.ASTARRAY_WALKTHROUGH_KEEP === "1") {
    console.log(`保留临时数据目录：${dataDirectory}`);
  } else {
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

process.exitCode = exitCode;
