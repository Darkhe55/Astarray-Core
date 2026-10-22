/**
 * ONBOARD-01-02 公开入口包级验收（2026-10-23）。
 *
 * 用法：node scripts/verify-onboarding-package.mjs --package-dir <已安装包目录>
 *
 * 判据（卡内：首次/适时触发、冷却、不再提示、迁移不重复弹、两处入口、不抢焦点、不隐式授权）：
 * 1. 全新状态 ⇒ `show-first`，两个入口都 `show` 且 `doesStealFocus:false`、`impliesAuthorization:false`；
 * 2. 忙碌（`--typing`）⇒ `suppress` + `user-busy`；
 * 3. `不再提示` 的持久化状态 ⇒ `suppress` + `never-show-again`；
 * 4. 冷却未到 ⇒ `suppress` + `cooldown`；
 * 5. 迁移后状态缺失 ⇒ 不重复弹首次（`state-unknown-after-migration`）；
 * 6. 状态文件损坏 ⇒ 非 0 退出（fail-closed）。
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArguments(argv) {
  const options = { packageDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") {
      options.packageDirectory = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.packageDirectory === null) {
  process.stderr.write("用法: node scripts/verify-onboarding-package.mjs --package-dir <已安装包目录>\n");
  process.exit(2);
}

const packageRoot = path.resolve(options.packageDirectory);
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const cliPath = path.join(packageRoot, "dist", "cli.js");
try {
  await fs.access(cliPath);
} catch {
  process.stderr.write(`未找到 CLI 入口：${cliPath}\n`);
  process.exit(2);
}

const failures = [];
const observations = {};
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-onboarding-e2e-"));

function runStatus(extraArguments) {
  return spawnSync(process.execPath, [cliPath, "onboarding", "status", "--json", ...extraArguments], {
    encoding: "utf8",
    // 注意：CLI 的状态目录是 <cwd>/.astarray（defaultStateDirectory 不读环境变量），
    // 因此这里把子进程的工作目录设到临时目录，避免污染仓库。
    cwd: stateDirectory,
    env: { ...process.env },
  });
}

function writeHintState(content) {
  const directory = path.join(stateDirectory, ".astarray", "onboarding");
  return fs.mkdir(directory, { recursive: true }).then(() => fs.writeFile(path.join(directory, "hint-state.json"), content, "utf8"));
}

try {
  // ① 全新状态：首次提示 + 两个入口可用且不抢焦点
  const fresh = runStatus(["--now", "2026-10-23T10:00:00.000Z"]);
  const freshReport = fresh.status === 0 ? JSON.parse(fresh.stdout) : null;
  observations.freshDecision = freshReport?.decision?.kind ?? null;
  if (freshReport?.decision?.kind !== "show-first") {
    failures.push(`全新状态应为 show-first（实际 ${String(observations.freshDecision)}）`);
  }
  const entries = freshReport?.entries ?? [];
  if (entries.length !== 2 || entries.some((entry) => entry.kind !== "show")) {
    failures.push("项目与秘书两处入口都应可用");
  }
  if (entries.some((entry) => entry.doesStealFocus !== false || entry.impliesAuthorization !== false)) {
    failures.push("入口不得抢焦点、不得隐式授权");
  }

  // ② 忙碌抑制
  const busy = JSON.parse(runStatus(["--typing", "--now", "2026-10-23T10:00:00.000Z"]).stdout);
  observations.busyReason = busy.decision.reasonCode ?? busy.decision.kind;
  if (busy.decision.kind !== "suppress" || busy.decision.reasonCode !== "user-busy") {
    failures.push("用户输入中应 suppress/user-busy");
  }

  // ③「不再提示」持久化生效
  await writeHintState(
    JSON.stringify({
      schemaVersion: 1,
      hasSeenFirstHint: true,
      isNeverShowAgain: true,
      lastShownAtIso: "2026-10-20T10:00:00.000Z",
      shownCount: 2,
    }),
  );
  const neverShow = JSON.parse(runStatus(["--now", "2026-10-23T10:00:00.000Z"]).stdout);
  observations.neverShowReason = neverShow.decision.reasonCode ?? neverShow.decision.kind;
  if (neverShow.decision.reasonCode !== "never-show-again") {
    failures.push("「不再提示」后应 never-show-again");
  }

  // ④ 冷却未到
  await writeHintState(
    JSON.stringify({
      schemaVersion: 1,
      hasSeenFirstHint: true,
      isNeverShowAgain: false,
      lastShownAtIso: "2026-10-22T10:00:00.000Z",
      shownCount: 1,
    }),
  );
  const cooled = JSON.parse(runStatus(["--milestone", "--now", "2026-10-23T10:00:00.000Z"]).stdout);
  observations.cooledReason = cooled.decision.reasonCode ?? cooled.decision.kind;
  if (cooled.decision.reasonCode !== "cooldown") {
    failures.push("冷却未到应 suppress/cooldown");
  }

  // ⑤ 迁移后状态缺失：不重复弹首次
  // 迁移场景必须用「首次状态」：已看过首次时冷却会先命中（这是实现的既定次序）
  await writeHintState(
    JSON.stringify({
      schemaVersion: 1,
      hasSeenFirstHint: false,
      isNeverShowAgain: false,
      lastShownAtIso: null,
      shownCount: 0,
    }),
  );
  const migration = JSON.parse(
    runStatus(["--migration-state-unknown", "--now", "2026-10-23T10:00:00.000Z"]).stdout,
  );
  observations.migrationReason = migration.decision.reasonCode ?? migration.decision.kind;
  if (migration.decision.reasonCode !== "state-unknown-after-migration") {
    failures.push("迁移后状态缺失应 state-unknown-after-migration");
  }

  // ⑥ 状态损坏 ⇒ fail-closed
  await writeHintState("{ broken");
  const broken = runStatus(["--now", "2026-10-23T10:00:00.000Z"]);
  observations.brokenStateStatus = broken.status;
  if (broken.status === 0) failures.push("状态文件损坏必须 fail-closed（非 0）");

  process.stdout.write(
    `${JSON.stringify(
      { packageName: packageJson.name, packageVersion: packageJson.version, observations, failures },
      null,
      2,
    )}\n`,
  );
} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`ONBOARD 包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write(
  "ONBOARD 包级验收通过：首次提示、忙碌/不再提示/冷却抑制、迁移不重复弹、两处入口不抢焦点、损坏状态 fail-closed\n",
);


